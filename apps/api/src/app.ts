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

const createShortlinkBody = z.object({
  url: z.string().url(),
  slug: z.string().min(1).max(20).regex(/^[a-zA-Z0-9_-]+$/).optional(),
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

  app.get('/clones', async () => {
    return prisma.clone.findMany({ orderBy: { createdAt: 'asc' } });
  });

  app.get('/polls', async () => {
    return prisma.poll.findMany({ orderBy: { createdAt: 'desc' }, take: 20 });
  });

  app.post('/polls', async (req, reply) => {
    const body = createPollBody.parse(req.body);
    const poll = await prisma.poll.create({
      data: {
        cloneSlug: 'poll',
        question: body.question,
        options: {
          create: body.options.map((text) => ({ text })),
        },
      },
      include: { options: true },
    });
    return poll;
  });

  app.get('/polls/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const poll = await prisma.poll.findUnique({
      where: { id },
      include: { options: true },
    });
    if (!poll) return reply.code(404).send({ error: 'Poll not found' });
    const tally = await tallyFor(id);
    return { ...poll, tally };
  });

  app.post('/polls/:id/votes', async (req, reply) => {
    const { id: pollId } = req.params as { id: string };
    const body = voteBody.parse(req.body);

    try {
      await prisma.vote.create({
        data: {
          pollId,
          optionId: body.optionId,
          voterId: body.voterId,
          idempotencyKey: body.idempotencyKey,
          fingerprint: (req.headers['user-agent'] ?? 'unknown') + (req.ip ?? '0.0.0.0'),
        },
      });
      app.log.info({ pollId, voterId: body.voterId, event: 'vote_cast' }, 'Vote cast');
      return tallyFor(pollId);
    } catch (e) {
      if (isUniqueViolation(e)) {
        app.log.info({ pollId, voterId: body.voterId, event: 'vote_collision' }, 'Vote collision');
        return reply.code(409).send(await tallyFor(pollId));
      }
      throw e;
    }
  });

  app.post('/shortlinks', async (req, reply) => {
    const body = createShortlinkBody.parse(req.body);
    const slug = body.slug ?? cryptoRandomId().slice(0, 8);

    try {
      const shortlink = await prisma.shortlink.create({
        data: { slug, url: body.url },
      });
      return shortlink;
    } catch (e) {
      if (isUniqueViolation(e)) {
        return reply.code(409).send({ error: 'Slug already taken' });
      }
      throw e;
    }
  });

  app.get('/s/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const shortlink = await prisma.shortlink.findUnique({
      where: { slug },
    });

    if (!shortlink) return reply.code(404).send({ error: 'Shortlink not found' });

    await prisma.shortlink.update({
      where: { slug },
      data: { clicks: { increment: 1 } },
    });

    return reply.redirect(shortlink.url);
  });

  return app;
}

function cryptoRandomId() {
  return Math.random().toString(36).substring(2, 15);
}
