import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './db';

function isUniqueViolation(e: unknown): e is Prisma.PrismaClientKnownRequestError {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

async function tallyFor(pollId: string) {
  const [rows, options] = await Promise.all([
    prisma.vote.groupBy({ by: ['optionId'], where: { pollId }, _count: { _all: true } }),
    prisma.option.findMany({ where: { pollId }, orderBy: { createdAt: 'asc' } }),
  ]);
  const counts = new Map(rows.map((r) => [r.optionId, r._count._all]));
  const total = rows.reduce((sum, r) => sum + r._count._all, 0);
  return { total, options: options.map((o) => ({ id: o.id, text: o.text, votes: counts.get(o.id) ?? 0 })) };
}

const createPollBody = z.object({ question: z.string().min(1), options: z.array(z.string().min(1)).min(2).max(10) });
const voteBody = z.object({ optionId: z.string().min(1), voterId: z.string().min(1), idempotencyKey: z.string().min(1) });
const createWalletBody = z.object({ ownerId: z.string().min(1), initialPaise: z.number().int().min(0).max(1e15).default(0) });
const transferBody = z.object({
  fromWalletId: z.string().min(1),
  toWalletId: z.string().min(1),
  amountPaise: z.number().int().positive(),
  idempotencyKey: z.string().min(1),
});

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization'] },
    genReqId: (req) => (req.headers['x-request-id'] as string) ?? cryptoRandomId(),
  });

  app.register(cors, { origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_req, reply) => {
    try { await prisma.$queryRaw`SELECT 1`; return { status: 'ready' }; }
    catch { return reply.code(503).send({ status: 'not_ready' }); }
  });

  app.get('/metrics', async (_req, reply) => {
    const [clones, polls, votes, wallets, transfers] = await Promise.all([
      prisma.clone.count(), prisma.poll.count(), prisma.vote.count(),
      prisma.wallet.count(), prisma.ledgerEntry.count(),
    ]);
    reply.header('content-type', 'text/plain; version=0.0.4');
    return [
      '# HELP openbuild_clones_total Number of clones.', '# TYPE openbuild_clones_total gauge', `openbuild_clones_total ${clones}`,
      '# HELP openbuild_polls_total Number of polls.', '# TYPE openbuild_polls_total counter', `openbuild_polls_total ${polls}`,
      '# HELP openbuild_votes_total Number of votes.', '# TYPE openbuild_votes_total counter', `openbuild_votes_total ${votes}`,
      '# HELP openbuild_wallets_total Number of wallets.', '# TYPE openbuild_wallets_total counter', `openbuild_wallets_total ${wallets}`,
      '# HELP openbuild_transfers_total Number of transfers.', '# TYPE openbuild_transfers_total counter', `openbuild_transfers_total ${transfers}`,
      '',
    ].join('\n');
  });

  app.get('/clones', async () => {
    const clones = await prisma.clone.findMany({ orderBy: { createdAt: 'asc' } });
    return { clones };
  });

  // Poll clone
  app.post('/clones/:slug/polls', async (req, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(req.params);
    const body = createPollBody.parse(req.body);
    const clone = await prisma.clone.findUnique({ where: { slug } });
    if (!clone) return reply.code(404).send({ error: 'clone_not_found' });
    const poll = await prisma.poll.create({
      data: { cloneSlug: slug, question: body.question, options: { create: body.options.map((text) => ({ text })) } },
      include: { options: { orderBy: { createdAt: 'asc' } } },
    });
    req.log.info({ event: 'poll.created', pollId: poll.id, cloneSlug: slug }, 'poll created');
    return reply.code(201).send({ id: poll.id, question: poll.question, options: poll.options.map((o) => ({ id: o.id, text: o.text })) });
  });

  app.get('/polls/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const poll = await prisma.poll.findUnique({ where: { id } });
    if (!poll) return reply.code(404).send({ error: 'poll_not_found' });
    return { id: poll.id, question: poll.question, tally: await tallyFor(id) };
  });

  app.post('/polls/:id/votes', async (req, reply) => {
    const { id: pollId } = z.object({ id: z.string() }).parse(req.params);
    const body = voteBody.parse(req.body);
    const option = await prisma.option.findFirst({ where: { id: body.optionId, pollId }, select: { id: true } });
    if (!option) return reply.code(404).send({ error: 'option_not_found' });
    const fingerprint = `${pollId}:${body.optionId}:${body.voterId}`;
    try {
      await prisma.vote.create({ data: { pollId, optionId: body.optionId, voterId: body.voterId, idempotencyKey: body.idempotencyKey, fingerprint } });
      req.log.info({ event: 'vote.counted', pollId, optionId: body.optionId, voterId: body.voterId }, 'vote counted');
      return reply.code(201).send({ status: 'counted', tally: await tallyFor(pollId) });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const existing = await prisma.vote.findUnique({ where: { pollId_idempotencyKey: { pollId, idempotencyKey: body.idempotencyKey } } });
      if (existing) {
        if (existing.fingerprint === fingerprint) {
          req.log.info({ event: 'vote.idempotent_replay', pollId, idempotencyKey: body.idempotencyKey }, 'idempotent replay');
          return reply.code(200).send({ status: 'duplicate_ignored', tally: await tallyFor(pollId) });
        }
        return reply.code(409).send({ error: 'idempotency_key_conflict' });
      }
      return reply.code(409).send({ error: 'already_voted' });
    }
  });

  // Wallet clone (atomic transfers + ledger + integer paise)
  app.post('/clones/:slug/wallets', async (req, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(req.params);
    const body = createWalletBody.parse(req.body);
    const clone = await prisma.clone.findUnique({ where: { slug } });
    if (!clone) return reply.code(404).send({ error: 'clone_not_found' });
    try {
      const wallet = await prisma.wallet.create({ data: { cloneSlug: slug, ownerId: body.ownerId, balancePaise: BigInt(body.initialPaise) } });
      req.log.info({ event: 'wallet.created', walletId: wallet.id, ownerId: body.ownerId }, 'wallet created');
      return reply.code(201).send({ id: wallet.id, ownerId: wallet.ownerId, balancePaise: wallet.balancePaise.toString() });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      return reply.code(409).send({ error: 'owner_already_has_wallet' });
    }
  });

  app.get('/wallets/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const wallet = await prisma.wallet.findUnique({ where: { id } });
    if (!wallet) return reply.code(404).send({ error: 'wallet_not_found' });
    return { id: wallet.id, ownerId: wallet.ownerId, balancePaise: wallet.balancePaise.toString() };
  });

  app.post('/clones/:slug/transfers', async (req, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(req.params);
    const body = transferBody.parse(req.body);

    if (body.fromWalletId === body.toWalletId) {
      return reply.code(400).send({ error: 'cannot_transfer_to_self' });
    }

    const fingerprint = `${body.fromWalletId}:${body.toWalletId}:${body.amountPaise}`;

    try {
      const result = await prisma.$transaction(async (tx) => {
        const from = await tx.wallet.findUnique({ where: { id: body.fromWalletId } });
        if (!from) throw new TransferError(404, 'from_wallet_not_found');

        const to = await tx.wallet.findUnique({ where: { id: body.toWalletId } });
        if (!to) throw new TransferError(404, 'to_wallet_not_found');

        if (from.balancePaise < BigInt(body.amountPaise)) {
          throw new TransferError(409, 'insufficient_balance');
        }

        await tx.wallet.update({ where: { id: from.id }, data: { balancePaise: from.balancePaise - BigInt(body.amountPaise) } });
        await tx.wallet.update({ where: { id: to.id }, data: { balancePaise: to.balancePaise + BigInt(body.amountPaise) } });

        const entry = await tx.ledgerEntry.create({
          data: {
            cloneSlug: slug,
            fromWalletId: from.id,
            toWalletId: to.id,
            amountPaise: BigInt(body.amountPaise),
            idempotencyKey: body.idempotencyKey,
            fingerprint,
          },
        });

        return { entryId: entry.id };
      });

      req.log.info({ event: 'transfer.completed', ...result }, 'transfer completed');
      return reply.code(201).send({ status: 'transferred', entryId: result.entryId });
    } catch (e) {
      if (e instanceof TransferError) {
        return reply.code(e.code).send({ error: e.message });
      }
      if (isUniqueViolation(e)) {
        const existing = await prisma.ledgerEntry.findUnique({ where: { idempotencyKey: body.idempotencyKey } });
        if (existing) {
          if (existing.fingerprint === fingerprint) {
            req.log.info({ event: 'transfer.idempotent_replay', idempotencyKey: body.idempotencyKey }, 'idempotent replay');
            return reply.code(200).send({ status: 'duplicate_ignored', entryId: existing.id });
          }
          req.log.warn({ event: 'transfer.key_conflict', idempotencyKey: body.idempotencyKey }, 'idempotency key reused');
          return reply.code(409).send({ error: 'idempotency_key_conflict' });
        }
      }
      throw e;
    }
  });

  app.get('/clones/:slug/ledger', async (req, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(req.params);
    const entries = await prisma.ledgerEntry.findMany({
      where: { cloneSlug: slug },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return { entries: entries.map((e) => ({
      id: e.id,
      fromWalletId: e.fromWalletId,
      toWalletId: e.toWalletId,
      amountPaise: e.amountPaise.toString(),
      idempotencyKey: e.idempotencyKey,
      createdAt: e.createdAt.toISOString(),
    })) };
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'validation_error', details: err.flatten() });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal_error' });
  });

  return app;
}

class TransferError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
