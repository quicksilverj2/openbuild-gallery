import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './db';
import { randomBytes } from 'crypto';

/**
 * OpenBuild Gallery API â€” Poll clone + Shortlink clone.
 *
 * The shortlink clone deduplicates identical URLs (unique index on url).
 * Under a concurrent burst of /shorten for the same URL, exactly one record
 * is created and all callers receive the same code. Collisions on the unique
 * index are translated into clean find-and-return (for url) or 409 (for alias).
 * Codes are non-enumerable: 8-char base64url from randomBytes.
 */

function isUniqueViolation(e: unknown): e is Prisma.PrismaClientKnownRequestError {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

function generateCode(): string {
  return randomBytes(6).toString('base64url');
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

const shortenBody = z.object({
  url: z.string().min(1).max(10000),
  alias: z.string().min(1).max(64).optional(),
});

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: ['req.headers.authorization'],
    },
    genReqId: (req) => (req.headers['x-request-id'] as string) ?? cryptoRandomId(),
  });

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

  app.get('/metrics', async (_req, reply) => {
    const [clones, polls, votes, shortlinks] = await Promise.all([
      prisma.clone.count(),
      prisma.poll.count(),
      prisma.vote.count(),
      prisma.shortlink.count(),
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

  // â”€â”€â”€ Poll clone â”€â”€â”€

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

  app.post('/polls/:id/votes', async (req, reply) => {
    const { id: pollId } = z.object({ id: z.string() }).parse(req.params);
    const body = voteBody.parse(req.body);

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
      if (!isUniqueViolation(e)) throw e;

      const existing = await prisma.vote.findUnique({
        where: { pollId_idempotencyKey: { pollId, idempotencyKey: body.idempotencyKey } },
      });

      if (existing) {
        if (existing.fingerprint === fingerprint) {
          req.log.info(
            { event: 'vote.idempotent_replay', pollId, idempotencyKey: body.idempotencyKey },
            'idempotent replay',
          );
          return reply
            .code(200)
            .send({ status: 'duplicate_ignored', tally: await tallyFor(pollId) });
        }
        req.log.warn(
          { event: 'vote.key_conflict', pollId, idempotencyKey: body.idempotencyKey },
          'idempotency key reused with a different body',
        );
        return reply.code(409).send({ error: 'idempotency_key_conflict' });
      }

      req.log.info(
        { event: 'vote.already_voted', pollId, voterId: body.voterId },
        'voter already voted',
      );
      return reply.code(409).send({ error: 'already_voted' });
    }
  });

  // â”€â”€â”€ Shortlink clone (dedup + non-enumerable codes) â”€â”€â”€

  app.post('/clones/:slug/shorten', async (req, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(req.params);
    const body = shortenBody.parse(req.body);
    const clone = await prisma.clone.findUnique({ where: { slug } });
    if (!clone) return reply.code(404).send({ error: 'clone_not_found' });

    // First, try to find an existing shortlink for this URL (dedup).
    const existing = await prisma.shortlink.findUnique({ where: { url: body.url } });
    if (existing) {
      req.log.info(
        { event: 'shortlink.dedup', shortlinkId: existing.id, code: existing.code },
        'shortlink deduped (url already exists)',
      );
      return reply.code(200).send({
        code: existing.code,
        alias: existing.alias,
        url: existing.url,
      });
    }

    // Not found â€” try to create. Under a concurrent burst, multiple requests
    // may reach here simultaneously. The unique index on url ensures only one
    // insert succeeds; the rest get P2002 and fall through to the dedup path.
    const code = generateCode();
    try {
      const link = await prisma.shortlink.create({
        data: {
          cloneSlug: slug,
          url: body.url,
          code,
          alias: body.alias,
        },
      });
      req.log.info(
        { event: 'shortlink.created', shortlinkId: link.id, code: link.code },
        'shortlink created',
      );
      return reply.code(201).send({
        code: link.code,
        alias: link.alias,
        url: link.url,
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;

      // Determine which unique constraint fired.
      const target = (e.meta?.target as string[]) ?? [];

      if (target.includes('url')) {
        // Another request created this URL first â€” dedup to it.
        const found = await prisma.shortlink.findUnique({ where: { url: body.url } });
        if (found) {
          req.log.info(
            { event: 'shortlink.dedup', shortlinkId: found.id, code: found.code },
            'shortlink deduped after race on url',
          );
          return reply.code(200).send({
            code: found.code,
            alias: found.alias,
            url: found.url,
          });
        }
      }

      if (target.includes('alias')) {
        req.log.warn(
          { event: 'shortlink.alias_conflict', alias: body.alias },
          'alias already taken by a different URL',
        );
        return reply.code(409).send({ error: 'alias_taken' });
      }

      // Code collision (astronomically unlikely) â€” retry once.
      if (target.includes('code')) {
        const code2 = generateCode();
        try {
          const link = await prisma.shortlink.create({
            data: {
              cloneSlug: slug,
              url: body.url,
              code: code2,
              alias: body.alias,
            },
          });
          req.log.info(
            { event: 'shortlink.created', shortlinkId: link.id, code: link.code },
            'shortlink created after code retry',
          );
          return reply.code(201).send({
            code: link.code,
            alias: link.alias,
            url: link.url,
          });
        } catch {
          // Still failing â€” fall through to dedup by url.
          const found = await prisma.shortlink.findUnique({ where: { url: body.url } });
          if (found) {
            return reply.code(200).send({
              code: found.code,
              alias: found.alias,
              url: found.url,
            });
          }
        }
      }

      // Fallback: try dedup by url one more time.
      const found = await prisma.shortlink.findUnique({ where: { url: body.url } });
      if (found) {
        return reply.code(200).send({
          code: found.code,
          alias: found.alias,
          url: found.url,
        });
      }

      return reply.code(409).send({ error: 'shortlink_conflict' });
    }
  });

  app.get('/s/:code', async (req, reply) => {
    const { code } = z.object({ code: z.string() }).parse(req.params);

    // Look up by code first, then by alias.
    const link = await prisma.shortlink.findUnique({ where: { code } });
    if (link) {
      req.log.info({ event: 'shortlink.redirect', code, url: link.url }, 'shortlink redirect');
      return reply.redirect(302, link.url);
    }

    const byAlias = await prisma.shortlink.findUnique({ where: { alias: code } });
    if (byAlias) {
      req.log.info(
        { event: 'shortlink.redirect', alias: code, url: byAlias.url },
        'shortlink redirect via alias',
      );
      return reply.redirect(302, byAlias.url);
    }

    return reply.code(404).send({ error: 'shortlink_not_found' });
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
