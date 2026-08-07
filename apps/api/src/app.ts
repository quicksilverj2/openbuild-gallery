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
const createVoucherBody = z.object({ code: z.string().min(1).max(256) });
const redeemBody = z.object({ userId: z.string().min(1) });

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization'] },
    genReqId: (req) => (req.headers['x-request-id'] as string) ?? cryptoRandomId(),
  });

  app.register(cors, { origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_req, reply) => {
    try { await prisma.\SELECT 1\; return { status: 'ready' }; }
    catch { return reply.code(503).send({ status: 'not_ready' }); }
  });

  app.get('/metrics', async (_req, reply) => {
    const [clones, polls, votes, vouchers, redemptions] = await Promise.all([
      prisma.clone.count(), prisma.poll.count(), prisma.vote.count(),
      prisma.voucher.count(), prisma.redemption.count(),
    ]);
    reply.header('content-type', 'text/plain; version=0.0.4');
    return [
      '# HELP openbuild_clones_total Number of clones.', '# TYPE openbuild_clones_total gauge', \openbuild_clones_total \,
      '# HELP openbuild_polls_total Number of polls.', '# TYPE openbuild_polls_total counter', \openbuild_polls_total \,
      '# HELP openbuild_votes_total Number of votes.', '# TYPE openbuild_votes_total counter', \openbuild_votes_total \,
      '# HELP openbuild_vouchers_total Number of vouchers.', '# TYPE openbuild_vouchers_total counter', \openbuild_vouchers_total \,
      '# HELP openbuild_redemptions_total Number of redemptions.', '# TYPE openbuild_redemptions_total counter', \openbuild_redemptions_total \,
      '',
    ].join('\n');
  });

  app.get('/clones', async () => {
    const clones = await prisma.clone.findMany({ orderBy: { createdAt: 'asc' } });
    return { clones };
  });

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
    const fingerprint = \:\:\;
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

  // Voucher clone (single-use, exactly-once, idempotent)
  app.post('/clones/:slug/vouchers', async (req, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(req.params);
    const body = createVoucherBody.parse(req.body);
    const clone = await prisma.clone.findUnique({ where: { slug } });
    if (!clone) return reply.code(404).send({ error: 'clone_not_found' });
    try {
      const voucher = await prisma.voucher.create({ data: { cloneSlug: slug, code: body.code } });
      req.log.info({ event: 'voucher.created', voucherId: voucher.id, code: body.code }, 'voucher created');
      return reply.code(201).send({ id: voucher.id, code: voucher.code });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      return reply.code(409).send({ error: 'voucher_code_taken' });
    }
  });

  app.post('/vouchers/:id/redeem', async (req, reply) => {
    const { id: voucherId } = z.object({ id: z.string() }).parse(req.params);
    const body = redeemBody.parse(req.body);
    const voucher = await prisma.voucher.findUnique({ where: { id: voucherId } });
    if (!voucher) return reply.code(404).send({ error: 'voucher_not_found' });
    const fingerprint = \:\;
    try {
      await prisma.redemption.create({ data: { voucherId, userId: body.userId, fingerprint } });
      req.log.info({ event: 'voucher.redeemed', voucherId, userId: body.userId }, 'voucher redeemed');
      return reply.code(201).send({ status: 'redeemed', voucherId });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const existing = await prisma.redemption.findUnique({ where: { voucherId } });
      if (existing) {
        if (existing.userId === body.userId) {
          req.log.info({ event: 'voucher.idempotent_replay', voucherId, userId: body.userId }, 'idempotent replay');
          return reply.code(200).send({ status: 'duplicate_ignored', voucherId });
        }
        req.log.info({ event: 'voucher.taken', voucherId, userId: body.userId }, 'voucher taken by another');
        return reply.code(409).send({ error: 'voucher_taken' });
      }
      return reply.code(409).send({ error: 'voucher_conflict' });
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'validation_error', details: err.flatten() });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal_error' });
  });

  return app;
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
