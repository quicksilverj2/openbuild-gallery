import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './db';

/**
 * OpenBuild Gallery API â€” the seed product is a "Poll" clone.
 * The Paste clone adds view-once + TTL pastes with atomic decrement.
 *
 * The interesting endpoint is POST /polls/:id/votes. Its whole job is to stay
 * correct under a concurrent burst: one vote per voter, safe client retries,
 * and NEVER a 5xx just because two requests raced. See prisma/schema.prisma for
 * why the data model makes that possible; see below for how collisions are
 * translated into clean 409 / idempotent-replay responses.
 *
 * The paste read endpoint (GET /pastes/:id) uses an atomic UPDATE ... WHERE
 * to decrement viewsRemaining so that exactly viewsAllowed reads succeed.
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
  content: z.string().min(1).max(100000),
  viewsAllowed: z.number().int().min(1).max(1000).default(1),
  ttlSeconds: z.number().int().min(1).max(86400 * 30).default(3600),
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
    const [clones, polls, votes, pastes] = await Promise.all([
      prisma.clone.count(),
      prisma.poll.count(),
      prisma.vote.count(),
      prisma.paste.count(),
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
      '# HELP openbuild_pastes_total Number of pastes created.',
      '# TYPE openbuild_pastes_total counter',
      `openbuild_pastes_total ${pastes}`,
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

  // â”€â”€â”€ Paste clone (view-once + TTL) â”€â”€â”€

  app.post('/clones/:slug/pastes', async (req, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(req.params);
    const body = createPasteBody.parse(req.body);
    const clone = await prisma.clone.findUnique({ where: { slug } });
    if (!clone) return reply.code(404).send({ error: 'clone_not_found' });

    const paste = await prisma.paste.create({
      data: {
        cloneSlug: slug,
        content: body.content,
        viewsAllowed: body.viewsAllowed,
        viewsRemaining: body.viewsAllowed,
        expiresAt: new Date(Date.now() + body.ttlSeconds * 1000),
      },
    });
    req.log.info(
      { event: 'paste.created', pasteId: paste.id, viewsAllowed: body.viewsAllowed },
      'paste created',
    );
    return reply.code(201).send({
      id: paste.id,
      viewsAllowed: paste.viewsAllowed,
      viewsRemaining: paste.viewsRemaining,
      expiresAt: paste.expiresAt.toISOString(),
    });
  });

  app.get('/pastes/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const now = new Date();

    // Fetch the paste first to check existence and expiry
    const paste = await prisma.paste.findUnique({ where: { id } });
    if (!paste) return reply.code(404).send({ error: 'paste_not_found' });

    // Expired -> 410 Gone
    if (paste.expiresAt <= now) {
      req.log.info({ event: 'paste.expired', pasteId: id }, 'paste expired');
      return reply.code(410).send({ error: 'paste_expired' });
    }

    // Atomic decrement: only succeeds if viewsRemaining > 0.
    // Under a concurrent burst, exactly viewsAllowed readers will get the content;
    // the rest get a clean 410 (exhausted), never a 5xx.
    const updated = await prisma.$executeRaw`
      UPDATE "Paste"
      SET "viewsRemaining" = "viewsRemaining" - 1
      WHERE "id" = ${id} AND "viewsRemaining" > 0
      RETURNING "content", "viewsRemaining"
    `;

    if (updated === 0) {
      // viewsRemaining was already 0 (or paste deleted concurrently)
      req.log.info({ event: 'paste.exhausted', pasteId: id }, 'paste views exhausted');
      return reply.code(410).send({ error: 'paste_exhausted' });
    }

    const rows = await prisma.$queryRaw<{ content: string; viewsRemaining: number }[]>`
      SELECT "content", "viewsRemaining" FROM "Paste" WHERE "id" = ${id}
    `;

    // If the paste was deleted between the decrement and the read, treat as gone
    if (!rows || rows.length === 0) {
      return reply.code(404).send({ error: 'paste_not_found' });
    }

    const row = rows[0];
    req.log.info(
      { event: 'paste.read', pasteId: id, viewsRemaining: row.viewsRemaining },
      'paste read',
    );

    return reply.code(200).send({
      id,
      content: row.content,
      viewsRemaining: row.viewsRemaining,
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
