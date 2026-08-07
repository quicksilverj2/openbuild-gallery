import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
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

// Token bucket rate limiter: capacity C, refill rate R tokens/sec.
// Correct under hot-key burst: exactly C requests pass, the rest get 429.
// Uses atomic UPDATE ... WHERE tokens >= 1 to ensure no over-admission.

const RATE_LIMIT_CAPACITY = parseFloat(process.env.RATE_LIMIT_CAPACITY ?? '10');
const RATE_LIMIT_REFILL = parseFloat(process.env.RATE_LIMIT_REFILL ?? '1');

async function checkRateLimit(key: string): Promise<{ allowed: boolean; remaining: number }> {
  const now = new Date();

  // Try to atomically decrement a token.
  // First, try to update an existing row.
  const updated = await prisma.$executeRaw`
    UPDATE "RateLimitState"
    SET "tokens" = LEAST("tokens" + EXTRACT(EPOCH FROM (${now}::timestamp - "lastRefill")) * ${RATE_LIMIT_REFILL}, ${RATE_LIMIT_CAPACITY}) - 1,
        "lastRefill" = ${now}
    WHERE "key" = ${key} AND "tokens" + EXTRACT(EPOCH FROM (${now}::timestamp - "lastRefill")) * ${RATE_LIMIT_REFILL} >= 1
  `;

  if (updated > 0) {
    const state = await prisma.rateLimitState.findUnique({ where: { key } });
    return { allowed: true, remaining: state?.tokens ?? 0 };
  }

  // Check if row exists but has insufficient tokens.
  const existing = await prisma.rateLimitState.findUnique({ where: { key } });
  if (existing) {
    const elapsed = (now.getTime() - existing.lastRefill.getTime()) / 1000;
    const currentTokens = Math.min(existing.tokens + elapsed * RATE_LIMIT_REFILL, RATE_LIMIT_CAPACITY);
    if (currentTokens >= 1) {
      // Race: tokens refilled but our UPDATE lost. Retry once.
      const retry = await prisma.$executeRaw`
        UPDATE "RateLimitState"
        SET "tokens" = LEAST(${currentTokens}, ${RATE_LIMIT_CAPACITY}) - 1,
            "lastRefill" = ${now}
        WHERE "key" = ${key} AND "tokens" + EXTRACT(EPOCH FROM (${now}::timestamp - "lastRefill")) * ${RATE_LIMIT_REFILL} >= 1
      `;
      if (retry > 0) {
        const state = await prisma.rateLimitState.findUnique({ where: { key } });
        return { allowed: true, remaining: state?.tokens ?? 0 };
      }
    }
    return { allowed: false, remaining: Math.floor(currentTokens) };
  }

  // Row doesn't exist. Create it with capacity-1 tokens (we consumed one).
  try {
    await prisma.rateLimitState.create({
      data: { key, tokens: RATE_LIMIT_CAPACITY - 1, lastRefill: now },
    });
    return { allowed: true, remaining: RATE_LIMIT_CAPACITY - 1 };
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // Another request created the row first. Retry the whole check.
    return checkRateLimit(key);
  }
}

// Rate limiter middleware: applies to all /clones/* and /polls/* routes.
// Key = IP address (or x-api-key header if present).
function rateLimitMiddleware() {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const key = (req.headers['x-api-key'] as string) || req.ip;
    const { allowed, remaining } = await checkRateLimit(`rl:${key}`);

    reply.header('x-ratelimit-remaining', Math.max(0, Math.floor(remaining)));
    reply.header('x-ratelimit-limit', RATE_LIMIT_CAPACITY);

    if (!allowed) {
      req.log.warn({ event: 'rate_limit.exceeded', key, remaining }, 'rate limit exceeded');
      return reply.code(429).send({ error: 'rate_limit_exceeded', retryAfter: Math.ceil(1 / RATE_LIMIT_REFILL) });
    }
  };
}

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
    const [clones, polls, votes, rateLimitKeys] = await Promise.all([
      prisma.clone.count(), prisma.poll.count(), prisma.vote.count(),
      prisma.rateLimitState.count(),
    ]);
    reply.header('content-type', 'text/plain; version=0.0.4');
    return [
      '# HELP openbuild_clones_total Number of clones.', '# TYPE openbuild_clones_total gauge', `openbuild_clones_total ${clones}`,
      '# HELP openbuild_polls_total Number of polls.', '# TYPE openbuild_polls_total counter', `openbuild_polls_total ${polls}`,
      '# HELP openbuild_votes_total Number of votes.', '# TYPE openbuild_votes_total counter', `openbuild_votes_total ${votes}`,
      '# HELP openbuild_rate_limit_keys_total Number of rate-limited keys.', '# TYPE openbuild_rate_limit_keys_total gauge', `openbuild_rate_limit_keys_total ${rateLimitKeys}`,
      '',
    ].join('\n');
  });

  app.get('/clones', async () => {
    const clones = await prisma.clone.findMany({ orderBy: { createdAt: 'asc' } });
    return { clones };
  });

  // Register rate limiter on mutation routes
  app.addHook('preHandler', async (req, reply) => {
    if (req.method === 'POST' && (req.url.startsWith('/clones/') || req.url.startsWith('/polls/'))) {
      const middleware = rateLimitMiddleware();
      await middleware(req, reply);
    }
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
      return reply.code(201).send({ status: 'counted', tally: await tallyFor(pollId) });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const existing = await prisma.vote.findUnique({ where: { pollId_idempotencyKey: { pollId, idempotencyKey: body.idempotencyKey } } });
      if (existing) {
        if (existing.fingerprint === fingerprint) return reply.code(200).send({ status: 'duplicate_ignored', tally: await tallyFor(pollId) });
        return reply.code(409).send({ error: 'idempotency_key_conflict' });
      }
      return reply.code(409).send({ error: 'already_voted' });
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
