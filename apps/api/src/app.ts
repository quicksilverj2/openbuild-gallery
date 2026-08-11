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

const createPasteBody = z.object({
  content: z.string().min(1),
  viewsAllowed: z.number().int().min(1),
  ttlSeconds: z.number().int().min(1).optional(),
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

    const paste = await prisma.paste.findUnique({ where: { id } });
    if (!paste) return reply.code(404).send({ error: 'paste_not_found' });

    const isExpired = paste.expiresAt && paste.expiresAt <= now;
    const isExhausted = paste.viewsUsed >= paste.viewsAllowed;

    if (isExpired || isExhausted) {
      req.log.info({ event: 'paste.rejected', pasteId: id, reason: isExpired ? 'expired' : 'exhausted' }, 'paste rejected');
      return reply.code(410).send({ error: isExpired ? 'paste_expired' : 'paste_exhausted' });
    }

    return reply.code(410).send({ error: 'paste_exhausted' });
  });

  app.get('/polls/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const poll = await prisma.poll.findUnique({ where: { id } });
    if (!poll) return reply.code(404).send({ error: 'poll_not_found' });
    return { id: poll.id, question: poll.question, tally: await tallyFor(id) };
  });

  app.post('/polls/:id/votes', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = voteBody.parse(req.body);

    try {
      await prisma.vote.create({
        data: {
          pollId: id,
          optionId: body.optionId,
          voterId: body.voterId,
          idempotencyKey: body.idempotencyKey,
          fingerprint: req.headers['user-agent'] ?? 'unknown',
        },
      });
      req.log.info({ event: 'vote.recorded', pollId: id, voterId: body.voterId }, 'vote recorded');
      return reply.code(201).send(await tallyFor(id));
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;

      const existing = await prisma.vote.findFirst({
        where: { pollId: id, idempotencyKey: body.idempotencyKey },
      });

      if (existing) {
        req.log.info({ event: 'vote.idempotent_replay', pollId: id, voterId: body.voterId }, 'idempotent replay');
        return reply.code(200).send(await tallyFor(id));
      }

      req.log.info({ event: 'vote.conflict', pollId: id, voterId: body.voterId }, 'vote conflict');
      return reply.code(409).send({ error: 'already_voted' });
    }
  });

  return app;
}

function cryptoRandomId() {
  return Math.random().toString(36).substring(2, 15);
}
