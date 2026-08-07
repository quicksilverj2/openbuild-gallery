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

const counters: Record<string, Record<string, number>> = {};

function bumpCounter(clone: string, event: string): void {
  if (!counters[clone]) counters[clone] = {};
  counters[clone][event] = (counters[clone][event] ?? 0) + 1;
}

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization'] },
    genReqId: (req) => (req.headers['x-request-id'] as string) ?? cryptoRandomId(),
  });

  app.register(cors, { origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true });

  app.addHook('onRequest', async (req) => {
    req.log.info({ event: 'request.start', method: req.method, url: req.url, requestId: req.id }, 'request started');
  });

  app.addHook('onResponse', async (req, reply) => {
    req.log.info({ event: 'request.end', method: req.method, url: req.url, statusCode: reply.statusCode, requestId: req.id, durationMs: reply.elapsedTime }, 'request completed');
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_req, reply) => {
    try { await prisma.$queryRaw`SELECT 1`; return { status: 'ready' }; }
    catch { return reply.code(503).send({ status: 'not_ready' }); }
  });

  app.get('/metrics', async (_req, reply) => {
    const [clones, polls, votes] = await Promise.all([
      prisma.clone.count(), prisma.poll.count(), prisma.vote.count(),
    ]);
    const lines: string[] = [
      '# HELP openbuild_clones_total Number of clones in the gallery.',
      '# TYPE openbuild_clones_total gauge',
      `openbuild_clones_total ${clones}`,
      '# HELP openbuild_polls_total Number of polls created.',
      '# TYPE openbuild_polls_total counter',
      `openbuild_polls_total ${polls}`,
      '# HELP openbuild_votes_total Number of votes recorded.',
      '# TYPE openbuild_votes_total counter',
      `openbuild_votes_total ${votes}`,
    ];
    for (const [clone, events] of Object.entries(counters)) {
      for (const [event, count] of Object.entries(events)) {
        lines.push(`# HELP openbuild_${clone}_${event}_total Counter for ${clone}.${event}`);
        lines.push(`# TYPE openbuild_${clone}_${event}_total counter`);
        lines.push(`openbuild_${clone}_${event}_total ${count}`);
      }
    }
    lines.push('');
    reply.header('content-type', 'text/plain; version=0.0.4');
    return lines.join('\n');
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
    bumpCounter(slug, 'poll_created');
    req.log.info({ event: 'poll.created', pollId: poll.id, cloneSlug: slug, requestId: req.id }, 'poll created');
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
      bumpCounter('poll', 'vote_counted');
      req.log.info({ event: 'vote.counted', pollId, optionId: body.optionId, voterId: body.voterId, requestId: req.id }, 'vote counted');
      return reply.code(201).send({ status: 'counted', tally: await tallyFor(pollId) });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const existing = await prisma.vote.findUnique({ where: { pollId_idempotencyKey: { pollId, idempotencyKey: body.idempotencyKey } } });
      if (existing) {
        if (existing.fingerprint === fingerprint) {
          bumpCounter('poll', 'vote_idempotent_replay');
          req.log.info({ event: 'vote.idempotent_replay', pollId, idempotencyKey: body.idempotencyKey, requestId: req.id }, 'idempotent replay');
          return reply.code(200).send({ status: 'duplicate_ignored', tally: await tallyFor(pollId) });
        }
        bumpCounter('poll', 'vote_key_conflict');
        req.log.warn({ event: 'vote.key_conflict', pollId, idempotencyKey: body.idempotencyKey, requestId: req.id }, 'idempotency key reused');
        return reply.code(409).send({ error: 'idempotency_key_conflict' });
      }
      bumpCounter('poll', 'vote_already_voted');
      req.log.info({ event: 'vote.already_voted', pollId, voterId: body.voterId, requestId: req.id }, 'voter already voted');
      return reply.code(409).send({ error: 'already_voted' });
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof z.ZodError) {
      req.log.warn({ event: 'validation_error', requestId: req.id, url: req.url }, 'validation error');
      return reply.code(400).send({ error: 'validation_error', details: err.flatten() });
    }
    req.log.error({ err, event: 'unhandled_error', requestId: req.id }, 'unhandled error');
    return reply.code(500).send({ error: 'internal_error' });
  });

  return app;
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
