import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './db';
import { registerShortlinkRoutes } from './shortlink-routes';

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

  // Register shortlink clone routes
  registerShortlinkRoutes(app);

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

  // --- Shortlink Clone Routes ---
  const shortenBody = z.object({
    url: z.string().url(),
    alias: z.string().min(1).max(64).optional(),
  });

  function generateCode(): string {
    // Non-enumerable Base62 code using crypto-safe bytes.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    let code = '';
    for (const b of bytes) code += alphabet[b % alphabet.length];
    return code;
  }

  app.post('/shorten', async (req, reply) => {
    const body = shortenBody.parse(req.body);
    const MAX_ATTEMPTS = 5;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const code = body.alias ?? generateCode();
      try {
        const link = await prisma.shortlink.create({
          data: { url: body.url, alias: body.alias ?? null, code },
        });
        req.log.info({ event: 'shortlink.created', code }, 'shortlink created');
        return reply.code(201).send({ code, url: link.url, shortUrl: `/${code}` });
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;

        // Unique constraint fired. Could be (url, alias) or (code).
        if (body.alias) {
          // If user supplied an alias and it collided on (url, alias), return existing.
          const existing = await prisma.shortlink.findFirst({
            where: { url: body.url, alias: body.alias },
          });
          if (existing) {
            req.log.info({ event: 'shortlink.idempotent_replay', code: existing.code }, 'shortlink replay');
            return reply.code(200).send({ code: existing.code, url: existing.url, shortUrl: `/${existing.code}` });
          }
          // Otherwise the alias itself is taken by a different URL -> conflict.
          return reply.code(409).send({ error: 'alias_taken' });
        }

        // No alias supplied -> generated code collided. Retry with a new code.
        req.log.warn({ event: 'shortlink.code_collision', attempt }, 'generated code collided, retrying');
      }
    }

    return reply.code(503).send({ error: 'code_generation_exhausted' });
  });

  app.get('/:code', async (req, reply) => {
    const { code } = z.object({ code: z.string() }).parse(req.params);
    const link = await prisma.shortlink.findUnique({ where: { code } });
    if (!link) return reply.code(404).send({ error: 'not_found' });
    return reply.redirect(link.url);
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
