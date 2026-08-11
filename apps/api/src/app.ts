import Fastify, { type FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './db';

/**
 * OpenBuild Gallery API — the seed product is a "Poll" clone.
 *
 * The interesting endpoint is POST /polls/:id/votes. Its whole job is to stay
 * correct under a concurrent burst: one vote per voter, safe client retries,
 * and NEVER a 5xx just because two requests raced. See prisma/schema.prisma for
 * why the data model makes that possible; see below for how collisions are
 * translated into clean 409 / idempotent-replay responses.
 */

function isUniqueViolation(e: unknown): e is Prisma.PrismaClientKnownRequestError {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

async function tallyFor(pollId: string) {
  const [rows, options] = await Promise.all([
    prisma.vote.groupBy({
      by: ['optionId'],
      where: { pollId },
      _count: { _all: true },
    }),
    prisma.option.findMany({ where: { pollId }, orderBy: { createdAt: 'asc' } }),
  ]);
  const counts = new Map(rows.map((r) => [r.optionId, r._count._all]));
  const total = rows.reduce((sum, r) => sum + r._count._all, 0);
  return {
    total,
    options: options.map((o) => ({ id: o.id, text: o.text, votes: counts.get(o.id) ?? 0 })),
  };
}

const createPollBody = z.object({
  question: z.string().min(1),
  options: z.array(z.string().min(1)).min(2).max(10),
});

const voteBody = z.object({
  optionId: z.string().min(1),
  voterId: z.string().min(1),
  idempotencyKey: z.string().min(1),
});

const createPasteBody = z.object({
  content: z.string().min(1),
  viewsAllowed: z.number().int().min(1),
  ttlSeconds: z.number().int().min(1).optional(),
});

const shortenBody = z.object({
  url: z.string().url(),
  alias: z
    .string()
    .min(3)
    .max(20)
    .regex(/^[a-zA-Z0-9_-]+$/)
    .optional(),
});

const depositBody = z.object({
  amount: z.number().int().positive(),
  idempotencyKey: z.string().min(1),
});

const transferBody = z.object({
  toWalletId: z.string().min(1),
  amount: z.number().int().positive(),
  idempotencyKey: z.string().min(1),
});

const createVoucherBody = z.object({
  code: z.string().min(3).max(20),
});

const redeemVoucherBody = z.object({
  code: z.string().min(1),
  userId: z.string().min(1),
  idempotencyKey: z.string().min(1),
});

export function buildApp(): FastifyInstance {
  const app = Fastify({
    // Structured JSON logs with a per-request correlation id — the observability
    // hook the reviewer bot reads to confirm the invariant events actually fired.
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: ['req.headers.authorization'],
    },
    genReqId: (req) => (req.headers['x-request-id'] as string) ?? cryptoRandomId(),
  });

  // BigInt serialization support
  app.setReplySerializer((payload) => {
    return JSON.stringify(payload, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'not_ready' });
    }
  });

  // Minimal Prometheus-style metrics: enough for the observability bounty to build on.
  app.get('/metrics', async (_req, reply) => {
    const [clones, polls, votes] = await Promise.all([
      prisma.clone.count(),
      prisma.poll.count(),
      prisma.vote.count(),
    ]);
    reply.header('content-type', 'text/plain; version=0.0.4');
    return [
      '# HELP openbuild_clones_total Number of clones in the gallery.',
      '# TYPE openbuild_clones_total gauge',
      `openbuild_clones_total ${clones}`,
      '# HELP openbuild_polls_total Number of polls created.',
      '# TYPE openbuild_polls_total counter',
      `openbuild_polls_total ${polls}`,
      '# HELP openbuild_votes_total Number of votes recorded.',
      '# TYPE openbuild_votes_total counter',
      `openbuild_votes_total ${votes}`,
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
      data: {
        cloneSlug: slug,
        question: body.question,
        options: { create: body.options.map((text) => ({ text })) },
      },
      include: { options: { orderBy: { createdAt: 'asc' } } },
    });
    req.log.info({ event: 'poll.created', pollId: poll.id, cloneSlug: slug }, 'poll created');
    return reply.code(201).send({
      id: poll.id,
      question: poll.question,
      options: poll.options.map((o) => ({ id: o.id, text: o.text })),
    });
  });

  app.post('/clones/:slug/pastes', async (req, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(req.params);
    const body = createPasteBody.parse(req.body);
    const clone = await prisma.clone.findUnique({ where: { slug } });
    if (!clone) return reply.code(404).send({ error: 'clone_not_found' });

    const expiresAt = body.ttlSeconds ? new Date(Date.now() + body.ttlSeconds * 1000) : null;

    const paste = await prisma.paste.create({
      data: {
        cloneSlug: slug,
        content: body.content,
        viewsAllowed: body.viewsAllowed,
        expiresAt,
      },
    });
    req.log.info({ event: 'paste.created', pasteId: paste.id, cloneSlug: slug }, 'paste created');
    return reply.code(201).send({
      id: paste.id,
      content: paste.content,
      viewsAllowed: paste.viewsAllowed,
      expiresAt: paste.expiresAt,
    });
  });

  app.get('/pastes/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const now = new Date();

    // The gate: atomic increment of viewsUsed ONLY if it hasn't hit the limit and
    // hasn't expired. We use a transaction to ensure we read the state AND update
    // it atomically, or just use updateMany and check affected rows.
    // updateMany is safer for concurrency without explicit locking.
    const result = await prisma.paste.updateMany({
      where: {
        id,
        viewsUsed: { lt: prisma.paste.fields.viewsAllowed },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      data: {
        viewsUsed: { increment: 1 },
      },
    });

    if (result.count === 1) {
      const paste = await prisma.paste.findUnique({ where: { id } });
      req.log.info({ event: 'paste.served', pasteId: id }, 'paste served');
      return { content: paste?.content, viewsRemaining: (paste?.viewsAllowed ?? 0) - (paste?.viewsUsed ?? 0) };
    }

    // If we are here, it's either not found, expired, or exhausted.
    const paste = await prisma.paste.findUnique({ where: { id } });
    if (!paste) return reply.code(404).send({ error: 'paste_not_found' });

    const isExpired = paste.expiresAt && paste.expiresAt <= now;
    const isExhausted = paste.viewsUsed >= paste.viewsAllowed;

    if (isExpired || isExhausted) {
      req.log.info({ event: 'paste.rejected', pasteId: id, reason: isExpired ? 'expired' : 'exhausted' }, 'paste rejected');
      return reply.code(410).send({ error: isExpired ? 'paste_expired' : 'paste_exhausted' });
    }

    // This should theoretically not happen if updateMany failed but it's not expired/exhausted,
    // unless someone else just took the last view between our updateMany and findUnique.
    return reply.code(410).send({ error: 'paste_exhausted' });
  });

  app.post('/clones/:slug/shorten', async (req, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(req.params);
    const body = shortenBody.parse(req.body);
    const clone = await prisma.clone.findUnique({ where: { slug } });
    if (!clone) return reply.code(404).send({ error: 'clone_not_found' });

    try {
      const shortlink = await prisma.shortlink.create({
        data: {
          cloneSlug: slug,
          url: body.url,
          code: body.alias || cryptoRandomId().slice(0, 8),
        },
      });
      req.log.info({ event: 'shortlink.created', code: shortlink.code, url: body.url }, 'shortlink created');
      return reply.code(201).send(shortlink);
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;

      // Collided on either URL (dedupe) or Code (alias conflict).
      const existingByUrl = await prisma.shortlink.findUnique({ where: { url: body.url } });
      if (existingByUrl) {
        req.log.info({ event: 'shortlink.deduped', code: existingByUrl.code, url: body.url }, 'shortlink deduped');
        return reply.code(200).send(existingByUrl);
      }

      // Must be an alias conflict.
      return reply.code(409).send({ error: 'alias_already_taken' });
    }
  });

  app.get('/s/:code', async (req, reply) => {
    const { code } = z.object({ code: z.string() }).parse(req.params);
    const shortlink = await prisma.shortlink.findUnique({ where: { code } });
    if (!shortlink) return reply.code(404).send({ error: 'shortlink_not_found' });

    req.log.info({ event: 'shortlink.redirect', code, url: shortlink.url }, 'shortlink redirect');
    return reply.redirect(shortlink.url);
  });

  app.post('/clones/:slug/wallets', async (req, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(req.params);
    const clone = await prisma.clone.findUnique({ where: { slug } });
    if (!clone) return reply.code(404).send({ error: 'clone_not_found' });

    const wallet = await prisma.wallet.create({
      data: { cloneSlug: slug },
    });
    req.log.info({ event: 'wallet.created', walletId: wallet.id }, 'wallet created');
    return reply.code(201).send(wallet);
  });

  app.get('/wallets/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const wallet = await prisma.wallet.findUnique({
      where: { id },
      include: {
        // We don't have a direct relation in the schema for Transaction -> Wallet, 
        // but we can query transactions by walletId.
      },
    });
    if (!wallet) return reply.code(404).send({ error: 'wallet_not_found' });

    const transactions = await prisma.transaction.findMany({
      where: { walletId: id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return { ...wallet, transactions };
  });

  app.post('/wallets/:id/deposit', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = depositBody.parse(req.body);

    try {
      const result = await prisma.$transaction(async (tx) => {
        const existing = await tx.transaction.findUnique({
          where: { walletId_idempotencyKey: { walletId: id, idempotencyKey: body.idempotencyKey } },
        });
        if (existing) return { status: 'idempotent_replay', transaction: existing };

        const transaction = await tx.transaction.create({
          data: {
            walletId: id,
            amount: BigInt(body.amount),
            type: 'DEPOSIT',
            idempotencyKey: body.idempotencyKey,
          },
        });

        const wallet = await tx.wallet.update({
          where: { id },
          data: { balance: { increment: BigInt(body.amount) } },
        });

        return { status: 'created', transaction, balance: wallet.balance };
      });

      req.log.info({ event: 'wallet.deposit', walletId: id, amount: body.amount }, 'deposit successful');
      return reply.code(result.status === 'created' ? 201 : 200).send(result);
    } catch (e) {
      if (isUniqueViolation(e)) return reply.code(409).send({ error: 'idempotency_key_conflict' });
      throw e;
    }
  });

  app.post('/wallets/:id/transfer', async (req, reply) => {
    const { id: fromId } = z.object({ id: z.string() }).parse(req.params);
    const body = transferBody.parse(req.body);

    try {
      const result = await prisma.$transaction(async (tx) => {
        // 1. Idempotency check
        const existing = await tx.transaction.findUnique({
          where: { walletId_idempotencyKey: { walletId: fromId, idempotencyKey: body.idempotencyKey } },
        });
        if (existing) return { status: 'idempotent_replay', transaction: existing };

        // 2. Verify destination exists
        const toWallet = await tx.wallet.findUnique({ where: { id: body.toWalletId } });
        if (!toWallet) throw new Error('destination_wallet_not_found');

        // 3. Atomic debit with balance check
        const debitResult = await tx.wallet.updateMany({
          where: {
            id: fromId,
            balance: { gte: BigInt(body.amount) },
          },
          data: {
            balance: { decrement: BigInt(body.amount) },
          },
        });

        if (debitResult.count === 0) {
          const fromWallet = await tx.wallet.findUnique({ where: { id: fromId } });
          if (!fromWallet) throw new Error('source_wallet_not_found');
          throw new Error('insufficient_funds');
        }

        // 4. Credit destination
        await tx.wallet.update({
          where: { id: body.toWalletId },
          data: { balance: { increment: BigInt(body.amount) } },
        });

        // 5. Record transaction
        const transaction = await tx.transaction.create({
          data: {
            walletId: fromId,
            amount: -BigInt(body.amount),
            type: 'TRANSFER',
            idempotencyKey: body.idempotencyKey,
          },
        });

        return { status: 'created', transaction };
      });

      req.log.info({ event: 'wallet.transfer', from: fromId, to: body.toWalletId, amount: body.amount }, 'transfer successful');
      return reply.code(result.status === 'created' ? 201 : 200).send(result);
    } catch (e: any) {
      if (isUniqueViolation(e)) return reply.code(409).send({ error: 'idempotency_key_conflict' });
      if (e.message === 'insufficient_funds') return reply.code(400).send({ error: 'insufficient_funds' });
      if (e.message === 'source_wallet_not_found') return reply.code(404).send({ error: 'source_wallet_not_found' });
      if (e.message === 'destination_wallet_not_found') return reply.code(404).send({ error: 'destination_wallet_not_found' });
      throw e;
    }
  });

  app.post('/clones/:slug/vouchers', async (req, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(req.params);
    const body = createVoucherBody.parse(req.body);
    const clone = await prisma.clone.findUnique({ where: { slug } });
    if (!clone) return reply.code(404).send({ error: 'clone_not_found' });

    try {
      const voucher = await prisma.voucher.create({
        data: {
          cloneSlug: slug,
          code: body.code,
        },
      });
      req.log.info({ event: 'voucher.created', voucherId: voucher.id, code: voucher.code }, 'voucher created');
      return reply.code(201).send(voucher);
    } catch (e) {
      if (isUniqueViolation(e)) return reply.code(409).send({ error: 'code_already_taken' });
      throw e;
    }
  });

  app.post('/vouchers/redeem', async (req, reply) => {
    const body = redeemVoucherBody.parse(req.body);
    const voucher = await prisma.voucher.findUnique({ where: { code: body.code } });
    if (!voucher) return reply.code(404).send({ error: 'voucher_not_found' });

    try {
      const redemption = await prisma.redemption.create({
        data: {
          voucherId: voucher.id,
          userId: body.userId,
          idempotencyKey: body.idempotencyKey,
        },
      });
      req.log.info({ event: 'voucher.redeemed', voucherId: voucher.id, userId: body.userId }, 'voucher redeemed');
      return reply.code(201).send(redemption);
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;

      const existing = await prisma.redemption.findUnique({
        where: { voucherId: voucher.id },
      });

      if (existing?.idempotencyKey === body.idempotencyKey && existing?.userId === body.userId) {
        req.log.info({ event: 'voucher.redeem_idempotent', voucherId: voucher.id, userId: body.userId }, 'voucher redeem idempotent');
        return reply.code(200).send(existing);
      }

      req.log.info({ event: 'voucher.redeem_conflict', voucherId: voucher.id, userId: body.userId }, 'voucher redeem conflict');
      return reply.code(409).send({ error: 'voucher_already_redeemed' });
    }
  });

  app.get('/polls/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const poll = await prisma.poll.findUnique({ where: { id } });
    if (!poll) return reply.code(404).send({ error: 'poll_not_found' });
    return { id: poll.id, question: poll.question, tally: await tallyFor(id) };
  });

  // The gate. Correct under concurrency, idempotent, and 5xx-free by construction.
  app.post('/polls/:id/votes', async (req, reply) => {
    const { id: pollId } = z.object({ id: z.string() }).parse(req.params);
    const body = voteBody.parse(req.body);

    // Option must exist AND belong to this poll (prevents cross-poll stuffing).
    const option = await prisma.option.findFirst({
      where: { id: body.optionId, pollId },
      select: { id: true },
    });
    if (!option) return reply.code(404).send({ error: 'option_not_found' });

    const fingerprint = `${pollId}:${body.optionId}:${body.voterId}`;

    try {
      await prisma.vote.create({
        data: {
          pollId,
          optionId: body.optionId,
          voterId: body.voterId,
          idempotencyKey: body.idempotencyKey,
          fingerprint,
        },
      });
      req.log.info(
        { event: 'vote.counted', pollId, optionId: body.optionId, voterId: body.voterId },
        'vote counted',
      );
      return reply.code(201).send({ status: 'counted', tally: await tallyFor(pollId) });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e; // a real fault -> 500 (must not happen under the burst)

      // A unique index rejected the insert. Figure out which invariant fired.
      const existing = await prisma.vote.findUnique({
        where: { pollId_idempotencyKey: { pollId, idempotencyKey: body.idempotencyKey } },
      });

      if (existing) {
        if (existing.fingerprint === fingerprint) {
          // Same key, same body -> a retry. Idempotent replay, counted exactly once.
          req.log.info(
            { event: 'vote.idempotent_replay', pollId, idempotencyKey: body.idempotencyKey },
            'idempotent replay',
          );
          return reply
            .code(200)
            .send({ status: 'duplicate_ignored', tally: await tallyFor(pollId) });
        }
        // Same key, DIFFERENT body -> client bug / abuse. Refuse.
        req.log.warn(
          { event: 'vote.key_conflict', pollId, idempotencyKey: body.idempotencyKey },
          'idempotency key reused with a different body',
        );
        return reply.code(409).send({ error: 'idempotency_key_conflict' });
      }

      // Not the idempotency key -> the (pollId, voterId) index fired. Already voted.
      req.log.info(
        { event: 'vote.already_voted', pollId, voterId: body.voterId },
        'voter already voted',
      );
      return reply.code(409).send({ error: 'already_voted' });
    }
  });

  // Uniform 400 for validation failures so the probe never sees a spurious 500.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: 'validation_error', details: err.flatten() });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal_error' });
  });

  return app;
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
