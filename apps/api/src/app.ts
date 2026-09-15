import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
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

  // The gallery is a static site on a different origin, so it calls this API
  // cross-origin. Reflect the configured origin(s), or any origin for the open
  // sandbox (no cookies/credentials are used, so reflect-any is safe here).
  app.register(cors, {
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true,
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

  // Wallet Clone Implementation — Accounts, deposits, atomic transfers, ledger & idempotency
  const accountBody = z.object({
    id: z.string().optional(),
  });

  const depositBody = z.object({
    accountId: z.string().min(1),
    amount: z.number().int().positive(),
    idempotencyKey: z.string().optional(),
  });

  const transferBody = z.object({
    fromAccountId: z.string().min(1),
    toAccountId: z.string().min(1),
    amount: z.number().int().positive(),
    idempotencyKey: z.string().optional(),
  });

  function deepEqual(a: any, b: any): boolean {
    if (a === b) return true;
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      if (Array.isArray(a) !== Array.isArray(b)) return false;
      const keysA = Object.keys(a);
      const keysB = Object.keys(b);
      if (keysA.length !== keysB.length) return false;
      for (const key of keysA) {
        if (!keysB.includes(key)) return false;
        if (!deepEqual(a[key], b[key])) return false;
      }
      return true;
    }
    return false;
  }

  app.post('/accounts', async (req, reply) => {
    const body = accountBody.parse(req.body || {});
    const idempotencyKey = (req.headers['x-idempotency-key'] as string) || (body as any)?.idempotencyKey;

    if (idempotencyKey) {
      const existing = await prisma.idempotency.findUnique({ where: { key: idempotencyKey } });
      if (existing) {
        if (deepEqual(JSON.parse(existing.requestBody), req.body || {})) {
          return reply.code(existing.responseStatus).send(JSON.parse(existing.responseBody));
        } else {
          return reply.code(409).send({ error: 'idempotency_key_conflict' });
        }
      }
    }

    try {
      const account = await prisma.$transaction(async (tx) => {
        const acc = await tx.account.create({
          data: {
            id: body.id,
            balance: 0,
          },
        });

        if (idempotencyKey) {
          await tx.idempotency.create({
            data: {
              key: idempotencyKey,
              requestPath: req.url,
              requestBody: JSON.stringify(req.body || {}),
              responseStatus: 201,
              responseBody: JSON.stringify({ id: acc.id, balance: acc.balance }),
            },
          });
        }
        return acc;
      });

      return reply.code(201).send({ id: account.id, balance: account.balance });
    } catch (e) {
      if (isUniqueViolation(e) && idempotencyKey) {
        const existing = await prisma.idempotency.findUnique({ where: { key: idempotencyKey } });
        if (existing) {
          if (deepEqual(JSON.parse(existing.requestBody), req.body || {})) {
            return reply.code(existing.responseStatus).send(JSON.parse(existing.responseBody));
          } else {
            return reply.code(409).send({ error: 'idempotency_key_conflict' });
          }
        }
      }
      if (isUniqueViolation(e)) {
        return reply.code(409).send({ error: 'account_already_exists' });
      }
      req.log.error({ err: e }, 'account creation failed');
      return reply.code(500).send({ error: 'account_creation_failed' });
    }
  });

  app.post('/deposits', async (req, reply) => {
    const body = depositBody.parse(req.body);
    const idempotencyKey = (req.headers['x-idempotency-key'] as string) || body.idempotencyKey;

    if (idempotencyKey) {
      const existing = await prisma.idempotency.findUnique({ where: { key: idempotencyKey } });
      if (existing) {
        if (deepEqual(JSON.parse(existing.requestBody), req.body)) {
          return reply.code(existing.responseStatus).send(JSON.parse(existing.responseBody));
        } else {
          return reply.code(409).send({ error: 'idempotency_key_conflict' });
        }
      }
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        const account = await tx.account.findUnique({ where: { id: body.accountId } });
        if (!account) {
          throw new Error('ACCOUNT_NOT_FOUND');
        }

        const updated = await tx.account.update({
          where: { id: body.accountId },
          data: { balance: { increment: body.amount } },
        });

        const ledger = await tx.ledgerEntry.create({
          data: {
            type: 'DEPOSIT',
            accountId: body.accountId,
            amount: body.amount,
            balanceAfter: updated.balance,
          },
        });

        const resData = {
          id: ledger.id,
          accountId: body.accountId,
          amount: body.amount,
          balanceAfter: updated.balance,
        };

        if (idempotencyKey) {
          await tx.idempotency.create({
            data: {
              key: idempotencyKey,
              requestPath: req.url,
              requestBody: JSON.stringify(req.body),
              responseStatus: 201,
              responseBody: JSON.stringify(resData),
            },
          });
        }

        return resData;
      });

      return reply.code(201).send(result);
    } catch (e: any) {
      if (isUniqueViolation(e) && idempotencyKey) {
        const existing = await prisma.idempotency.findUnique({ where: { key: idempotencyKey } });
        if (existing) {
          if (deepEqual(JSON.parse(existing.requestBody), req.body)) {
            return reply.code(existing.responseStatus).send(JSON.parse(existing.responseBody));
          } else {
            return reply.code(409).send({ error: 'idempotency_key_conflict' });
          }
        }
      }
      if (e.message === 'ACCOUNT_NOT_FOUND') {
        return reply.code(404).send({ error: 'account_not_found' });
      }
      req.log.error({ err: e }, 'deposit failed');
      return reply.code(500).send({ error: 'deposit_failed' });
    }
  });

  app.post('/transfers', async (req, reply) => {
    const body = transferBody.parse(req.body);
    const idempotencyKey = (req.headers['x-idempotency-key'] as string) || body.idempotencyKey;

    if (body.fromAccountId === body.toAccountId) {
      return reply.code(400).send({ error: 'invalid_transfer_destination' });
    }

    if (idempotencyKey) {
      const existing = await prisma.idempotency.findUnique({ where: { key: idempotencyKey } });
      if (existing) {
        if (deepEqual(JSON.parse(existing.requestBody), req.body)) {
          return reply.code(existing.responseStatus).send(JSON.parse(existing.responseBody));
        } else {
          return reply.code(409).send({ error: 'idempotency_key_conflict' });
        }
      }
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        // 1. Atomic decrement from source using updateMany for concurrency safety
        const updatedFrom = await tx.account.updateMany({
          where: { id: body.fromAccountId, balance: { gte: body.amount } },
          data: { balance: { decrement: body.amount } },
        });

        if (updatedFrom.count === 0) {
          const fromExists = await tx.account.findUnique({ where: { id: body.fromAccountId } });
          if (!fromExists) throw new Error('FROM_ACCOUNT_NOT_FOUND');
          throw new Error('INSUFFICIENT_FUNDS');
        }

        // 2. Ensure target exists and increment balance
        const toExists = await tx.account.findUnique({ where: { id: body.toAccountId } });
        if (!toExists) throw new Error('TO_ACCOUNT_NOT_FOUND');

        const updatedTo = await tx.account.update({
          where: { id: body.toAccountId },
          data: { balance: { increment: body.amount } },
        });

        // 3. Fetch current balance of fromAccount to log in ledger correctly
        const fromAccount = await tx.account.findUniqueOrThrow({ where: { id: body.fromAccountId } });

        // 4. Create ledger entries
        const entryFrom = await tx.ledgerEntry.create({
          data: {
            type: 'TRANSFER_OUT',
            accountId: body.fromAccountId,
            relatedAccountId: body.toAccountId,
            amount: body.amount,
            balanceAfter: fromAccount.balance,
          },
        });

        await tx.ledgerEntry.create({
          data: {
            type: 'TRANSFER_IN',
            accountId: body.toAccountId,
            relatedAccountId: body.fromAccountId,
            amount: body.amount,
            balanceAfter: updatedTo.balance,
          },
        });

        const resData = {
          id: entryFrom.id,
          fromAccountId: body.fromAccountId,
          toAccountId: body.toAccountId,
          amount: body.amount,
          fromBalanceAfter: fromAccount.balance,
          toBalanceAfter: updatedTo.balance,
        };

        if (idempotencyKey) {
          await tx.idempotency.create({
            data: {
              key: idempotencyKey,
              requestPath: req.url,
              requestBody: JSON.stringify(req.body),
              responseStatus: 201,
              responseBody: JSON.stringify(resData),
            },
          });
        }

        return resData;
      });

      return reply.code(201).send(result);
    } catch (e: any) {
      if (isUniqueViolation(e) && idempotencyKey) {
        const existing = await prisma.idempotency.findUnique({ where: { key: idempotencyKey } });
        if (existing) {
          if (deepEqual(JSON.parse(existing.requestBody), req.body)) {
            return reply.code(existing.responseStatus).send(JSON.parse(existing.responseBody));
          } else {
            return reply.code(409).send({ error: 'idempotency_key_conflict' });
          }
        }
      }
      if (e.message === 'FROM_ACCOUNT_NOT_FOUND') {
        return reply.code(404).send({ error: 'from_account_not_found' });
      }
      if (e.message === 'TO_ACCOUNT_NOT_FOUND') {
        return reply.code(404).send({ error: 'to_account_not_found' });
      }
      if (e.message === 'INSUFFICIENT_FUNDS') {
        return reply.code(400).send({ error: 'insufficient_funds' });
      }
      req.log.error({ err: e }, 'transfer failed');
      return reply.code(500).send({ error: 'transfer_failed' });
    }
  });

  app.get('/accounts/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);

    const account = await prisma.account.findUnique({ where: { id } });
    if (!account) {
      return reply.code(404).send({ error: 'account_not_found' });
    }

    const ledger = await prisma.ledgerEntry.findMany({
      where: { accountId: id },
      orderBy: { createdAt: 'desc' },
    });

    return reply.send({
      id: account.id,
      balance: account.balance,
      ledger: ledger.map((entry) => ({
        id: entry.id,
        type: entry.type,
        accountId: entry.accountId,
        relatedAccountId: entry.relatedAccountId,
        amount: entry.amount,
        balanceAfter: entry.balanceAfter,
        createdAt: entry.createdAt,
      })),
    });
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
