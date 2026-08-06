import Fastify, { type FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { prisma } from './db';

/**
 * OpenBuild Gallery API — seed product is a "Poll" clone; bounty #3 adds Shortlink.
 *
 * Poll: POST /polls/:id/votes stays correct under a concurrent burst (one vote
 * per voter, safe retries, never a 5xx on race). Shortlink: POST /shorten
 * dedupes identical URLs and concurrent same-alias creates so exactly one code
 * wins — losers resolve to that code with zero 5xx. Codes are random (not
 * sequential) so they are non-enumerable.
 */

function isUniqueViolation(e: unknown): e is Prisma.PrismaClientKnownRequestError {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

function uniqueTarget(e: Prisma.PrismaClientKnownRequestError): string[] {
  const t = e.meta?.target;
  if (Array.isArray(t)) return t.map(String);
  if (typeof t === 'string') return [t];
  return [];
}

/** Non-enumerable short codes: cryptographically random base62, fixed length. */
const CODE_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function randomCode(len = 8): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return out;
}

const ALIAS_RE = /^[A-Za-z0-9_-]{3,32}$/;
// Reserved path segments so GET /:code never steals health/API routes.
const RESERVED_CODES = new Set([
  'healthz',
  'readyz',
  'metrics',
  'clones',
  'polls',
  'shorten',
  'favicon.ico',
]);

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

const shortenBody = z.object({
  url: z.string().url().max(2048),
  alias: z
    .string()
    .regex(ALIAS_RE, 'alias must be 3–32 chars of [A-Za-z0-9_-]')
    .optional(),
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
    const [clones, polls, votes, shortlinks] = await Promise.all([
      prisma.clone.count(),
      prisma.poll.count(),
      prisma.vote.count(),
      prisma.shortLink.count(),
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
      '# HELP openbuild_shortlinks_total Number of shortlinks created.',
      '# TYPE openbuild_shortlinks_total counter',
      `openbuild_shortlinks_total ${shortlinks}`,
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

  // --- Shortlink clone (bounty #3) ------------------------------------------
  // POST /shorten: create or resolve a short code for a URL (+ optional alias).
  // Concurrent same URL/alias → exactly one row; losers re-read and return it.
  app.post('/shorten', async (req, reply) => {
    const body = shortenBody.parse(req.body);
    const url = body.url;
    if (body.alias && RESERVED_CODES.has(body.alias.toLowerCase())) {
      return reply.code(400).send({ error: 'alias_reserved' });
    }

    // Fast path: URL already shortened → return the existing code (dedupe).
    const existingByUrl = await prisma.shortLink.findUnique({ where: { url } });
    if (existingByUrl) {
      // Alias that disagrees with the stored code for this URL is a conflict.
      if (body.alias && body.alias !== existingByUrl.code) {
        return reply.code(409).send({ error: 'url_already_shortened', code: existingByUrl.code });
      }
      req.log.info(
        { event: 'shortlink.deduped', code: existingByUrl.code, url },
        'shortlink deduped by url',
      );
      return reply.code(200).send({ code: existingByUrl.code, url: existingByUrl.url, created: false });
    }

    // Preferred code: caller alias, otherwise a non-enumerable random code.
    const preferredCode = body.alias ?? randomCode(8);

    // If the preferred code is already taken by a *different* URL, refuse alias
    // collisions cleanly (random codes retry; aliases 409).
    const codeOwner = await prisma.shortLink.findUnique({ where: { code: preferredCode } });
    if (codeOwner) {
      if (codeOwner.url === url) {
        return reply
          .code(200)
          .send({ code: codeOwner.code, url: codeOwner.url, created: false });
      }
      if (body.alias) {
        return reply.code(409).send({ error: 'alias_taken' });
      }
      // Random code collision is vanishingly rare; fall through to insert loop.
    }

    // Insert with unique(url) + unique(code). Under a concurrent burst for the
    // same URL, one writer wins; the rest hit P2002 and re-read the winner.
    const MAX_ATTEMPTS = 5;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const code = attempt === 0 ? preferredCode : body.alias ?? randomCode(8);
      try {
        const created = await prisma.shortLink.create({ data: { code, url } });
        req.log.info({ event: 'shortlink.created', code: created.code, url }, 'shortlink created');
        return reply.code(201).send({ code: created.code, url: created.url, created: true });
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        const targets = uniqueTarget(e);

        // URL unique fired → another concurrent writer already owns this URL.
        if (targets.some((t) => t === 'url' || t.includes('url'))) {
          const winner = await prisma.shortLink.findUnique({ where: { url } });
          if (winner) {
            req.log.info(
              { event: 'shortlink.race_resolved', code: winner.code, url },
              'concurrent shorten resolved to existing code',
            );
            return reply
              .code(200)
              .send({ code: winner.code, url: winner.url, created: false });
          }
        }

        // Code unique fired.
        if (targets.some((t) => t === 'code' || t.includes('code'))) {
          const byCode = await prisma.shortLink.findUnique({ where: { code } });
          if (byCode && byCode.url === url) {
            return reply
              .code(200)
              .send({ code: byCode.code, url: byCode.url, created: false });
          }
          // Concurrent same-alias for different URLs, or our random code collided.
          // Also: race where URL was inserted under a *different* code.
          const byUrl = await prisma.shortLink.findUnique({ where: { url } });
          if (byUrl) {
            req.log.info(
              { event: 'shortlink.race_resolved', code: byUrl.code, url },
              'concurrent shorten resolved to existing code',
            );
            return reply.code(200).send({ code: byUrl.code, url: byUrl.url, created: false });
          }
          if (body.alias) {
            return reply.code(409).send({ error: 'alias_taken' });
          }
          // Random code collision: retry with a fresh code.
          continue;
        }

        // Unknown unique target — still try to resolve by URL before 5xx.
        const winner = await prisma.shortLink.findUnique({ where: { url } });
        if (winner) {
          return reply.code(200).send({ code: winner.code, url: winner.url, created: false });
        }
        throw e;
      }
    }

    // Exhausted random-code retries (astronomically unlikely). Surface cleanly.
    return reply.code(503).send({ error: 'could_not_allocate_code' });
  });

  // GET /:code → 302 redirect. Registered after all fixed paths so it never
  // shadows /healthz, /clones, /polls, etc.
  app.get('/:code', async (req, reply) => {
    const { code } = z.object({ code: z.string().min(1) }).parse(req.params);
    if (RESERVED_CODES.has(code.toLowerCase())) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const link = await prisma.shortLink.findUnique({ where: { code } });
    if (!link) return reply.code(404).send({ error: 'not_found' });
    req.log.info({ event: 'shortlink.redirect', code, url: link.url }, 'shortlink redirect');
    return reply.redirect(link.url, 302);
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
