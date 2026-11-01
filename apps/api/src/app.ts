import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './db';
import {
  PerCloneMetricsRegistry,
  registerObservabilityMiddleware,
} from './observability';

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

export interface BuildAppOptions {
  logStream?: NodeJS.WritableStream;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const metricsRegistry = new PerCloneMetricsRegistry();
  const pollCloneCache = new Map<string, string>();

  const app = Fastify({
    // Structured JSON logs with a per-request correlation id — the observability
    // hook the reviewer bot reads to confirm the invariant events actually fired.
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: ['req.headers.authorization'],
      ...(options.logStream ? { stream: options.logStream } : {}),
    },
    genReqId: (req) => (req.headers['x-request-id'] as string) ?? cryptoRandomId(),
  });

  // The gallery is a static site on a different origin, so it calls this API
  // cross-origin. Reflect the configured origin(s), or any origin for the open
  // sandbox (no cookies/credentials are used, so reflect-any is safe here).
  app.register(cors, {
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true,
  });

  registerObservabilityMiddleware(app, metricsRegistry, async (pollId: string) => {
    const cached = pollCloneCache.get(pollId);
    if (cached) return cached;
    const poll = await prisma.poll.findUnique({
      where: { id: pollId },
      select: { cloneSlug: true },
    });
    if (poll?.cloneSlug) {
      pollCloneCache.set(pollId, poll.cloneSlug);
      return poll.cloneSlug;
    }
    return null;
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

  // Prometheus-style metrics including per-clone DB & middleware counters.
  app.get('/metrics', async (_req, reply) => {
    const [clonesList, pollsByClone, votesWithPolls] = await Promise.all([
      prisma.clone.findMany({ select: { slug: true }, orderBy: { slug: 'asc' } }),
      prisma.poll.groupBy({
        by: ['cloneSlug'],
        _count: { _all: true },
      }),
      prisma.vote.findMany({
        select: { poll: { select: { cloneSlug: true } } },
      }),
    ]);

    const cloneSlugs = new Set<string>(clonesList.map((c) => c.slug));
    for (const [slug] of metricsRegistry.entries()) {
      cloneSlugs.add(slug);
    }

    const pollCountByClone = new Map<string, number>();
    let totalPolls = 0;
    for (const row of pollsByClone) {
      pollCountByClone.set(row.cloneSlug, row._count._all);
      totalPolls += row._count._all;
      cloneSlugs.add(row.cloneSlug);
    }

    const voteCountByClone = new Map<string, number>();
    let totalVotes = 0;
    for (const v of votesWithPolls) {
      const slug = v.poll.cloneSlug;
      voteCountByClone.set(slug, (voteCountByClone.get(slug) ?? 0) + 1);
      totalVotes += 1;
      cloneSlugs.add(slug);
    }

    const lines: string[] = [
      '# HELP openbuild_clones_total Number of clones in the gallery.',
      '# TYPE openbuild_clones_total gauge',
      `openbuild_clones_total ${clonesList.length}`,
      '# HELP openbuild_polls_total Number of polls created.',
      '# TYPE openbuild_polls_total counter',
      `openbuild_polls_total ${totalPolls}`,
      '# HELP openbuild_votes_total Number of votes recorded.',
      '# TYPE openbuild_votes_total counter',
      `openbuild_votes_total ${totalVotes}`,
      '# HELP openbuild_clone_polls_total Number of polls created per clone.',
      '# TYPE openbuild_clone_polls_total counter',
    ];

    const sortedSlugs = Array.from(cloneSlugs).sort();
    for (const slug of sortedSlugs) {
      lines.push(`openbuild_clone_polls_total{clone="${slug}"} ${pollCountByClone.get(slug) ?? 0}`);
    }

    lines.push(
      '# HELP openbuild_clone_votes_total Number of votes recorded per clone.',
      '# TYPE openbuild_clone_votes_total counter',
    );
    for (const slug of sortedSlugs) {
      lines.push(`openbuild_clone_votes_total{clone="${slug}"} ${voteCountByClone.get(slug) ?? 0}`);
    }

    lines.push(
      '# HELP openbuild_clone_requests_total HTTP requests processed per clone by method and status.',
      '# TYPE openbuild_clone_requests_total counter',
    );
    for (const [slug, snap] of metricsRegistry.entries()) {
      for (const [methodStatus, count] of snap.requestsByStatus.entries()) {
        const [method, status] = methodStatus.split(':');
        lines.push(
          `openbuild_clone_requests_total{clone="${slug}",method="${method}",status="${status}"} ${count}`,
        );
      }
    }

    lines.push(
      '# HELP openbuild_clone_invariant_events_total Invariant and domain events observed per clone.',
      '# TYPE openbuild_clone_invariant_events_total counter',
    );
    for (const [slug, snap] of metricsRegistry.entries()) {
      for (const [event, count] of snap.invariantEvents.entries()) {
        lines.push(`openbuild_clone_invariant_events_total{clone="${slug}",event="${event}"} ${count}`);
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
    req.cloneSlug = slug;
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
    pollCloneCache.set(poll.id, slug);
    req.recordInvariant?.('poll.created', { pollId: poll.id, cloneSlug: slug }, 'poll created');
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
    req.cloneSlug = poll.cloneSlug;
    pollCloneCache.set(poll.id, poll.cloneSlug);
    return { id: poll.id, question: poll.question, tally: await tallyFor(id) };
  });

  // The gate. Correct under concurrency, idempotent, and 5xx-free by construction.
  app.post('/polls/:id/votes', async (req, reply) => {
    const { id: pollId } = z.object({ id: z.string() }).parse(req.params);
    const body = voteBody.parse(req.body);

    // Option must exist AND belong to this poll (prevents cross-poll stuffing).
    const option = await prisma.option.findFirst({
      where: { id: body.optionId, pollId },
      select: { id: true, poll: { select: { cloneSlug: true } } },
    });
    if (!option) return reply.code(404).send({ error: 'option_not_found' });

    const cloneSlug = option.poll.cloneSlug;
    req.cloneSlug = cloneSlug;
    pollCloneCache.set(pollId, cloneSlug);

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
      req.recordInvariant?.(
        'vote.counted',
        { pollId, optionId: body.optionId, voterId: body.voterId, cloneSlug },
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
          req.recordInvariant?.(
            'vote.idempotent_replay',
            { pollId, idempotencyKey: body.idempotencyKey, cloneSlug },
            'idempotent replay',
          );
          return reply
            .code(200)
            .send({ status: 'duplicate_ignored', tally: await tallyFor(pollId) });
        }
        // Same key, DIFFERENT body -> client bug / abuse. Refuse.
        req.recordInvariant?.(
          'vote.key_conflict',
          { pollId, idempotencyKey: body.idempotencyKey, cloneSlug },
          'idempotency key reused with a different body',
          'warn',
        );
        return reply.code(409).send({ error: 'idempotency_key_conflict' });
      }

      // Not the idempotency key -> the (pollId, voterId) index fired. Already voted (race lost).
      req.recordInvariant?.(
        'vote.already_voted',
        { pollId, voterId: body.voterId, cloneSlug, reason: 'race_lost' },
        'voter already voted (race lost)',
      );
      return reply.code(409).send({ error: 'already_voted' });
    }
  });

  // Uniform 400 for validation failures so the probe never sees a spurious 500.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: 'validation_error', details: err.flatten() });
    }
    req.log.error({ err, reqId: req.id, cloneSlug: req.cloneSlug }, 'unhandled error');
    return reply.code(500).send({ error: 'internal_error' });
  });

  return app;
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
