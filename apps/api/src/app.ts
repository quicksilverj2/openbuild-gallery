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
const createItemBody = z.object({ name: z.string().min(1), totalUnits: z.number().int().min(1) });
const reserveBody = z.object({ userId: z.string().min(1), units: z.number().int().min(1), idempotencyKey: z.string().min(1) });

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
    const [clones, polls, votes, items, reservations] = await Promise.all([
      prisma.clone.count(), prisma.poll.count(), prisma.vote.count(),
      prisma.inventoryItem.count(), prisma.reservation.count(),
    ]);
    reply.header('content-type', 'text/plain; version=0.0.4');
    return [
      '# HELP openbuild_clones_total Number of clones.', '# TYPE openbuild_clones_total gauge', `openbuild_clones_total ${clones}`,
      '# HELP openbuild_polls_total Number of polls.', '# TYPE openbuild_polls_total counter', `openbuild_polls_total ${polls}`,
      '# HELP openbuild_votes_total Number of votes.', '# TYPE openbuild_votes_total counter', `openbuild_votes_total ${votes}`,
      '# HELP openbuild_items_total Number of inventory items.', '# TYPE openbuild_items_total counter', `openbuild_items_total ${items}`,
      '# HELP openbuild_reservations_total Number of reservations.', '# TYPE openbuild_reservations_total counter', `openbuild_reservations_total ${reservations}`,
      '',
    ].join('\n');
  });

  app.get('/clones', async () => {
    const clones = await prisma.clone.findMany({ orderBy: { createdAt: 'asc' } });
    return { clones };
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

  // Inventory clone (never oversell, idempotent, releasable)
  app.post('/clones/:slug/items', async (req, reply) => {
    const { slug } = z.object({ slug: z.string() }).parse(req.params);
    const body = createItemBody.parse(req.body);
    const clone = await prisma.clone.findUnique({ where: { slug } });
    if (!clone) return reply.code(404).send({ error: 'clone_not_found' });
    const item = await prisma.inventoryItem.create({ data: { cloneSlug: slug, name: body.name, totalUnits: body.totalUnits } });
    req.log.info({ event: 'item.created', itemId: item.id, name: body.name, totalUnits: body.totalUnits }, 'inventory item created');
    return reply.code(201).send({ id: item.id, name: item.name, totalUnits: item.totalUnits, reservedUnits: item.reservedUnits });
  });

  app.get('/items/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const item = await prisma.inventoryItem.findUnique({ where: { id } });
    if (!item) return reply.code(404).send({ error: 'item_not_found' });
    return { id: item.id, name: item.name, totalUnits: item.totalUnits, reservedUnits: item.reservedUnits, available: item.totalUnits - item.reservedUnits };
  });

  app.post('/items/:id/reserve', async (req, reply) => {
    const { id: itemId } = z.object({ id: z.string() }).parse(req.params);
    const body = reserveBody.parse(req.body);
    const item = await prisma.inventoryItem.findUnique({ where: { id: itemId } });
    if (!item) return reply.code(404).send({ error: 'item_not_found' });
    const fingerprint = `${itemId}:${body.userId}:${body.units}`;

    try {
      const result = await prisma.$transaction(async (tx) => {
        const updated = await tx.$executeRaw`UPDATE "InventoryItem" SET "reservedUnits" = "reservedUnits" + ${body.units} WHERE "id" = ${itemId} AND "reservedUnits" + ${body.units} <= "totalUnits"`;
        if (updated === 0) throw new ReserveError(409, 'insufficient_units');
        const reservation = await tx.reservation.create({
          data: { itemId, userId: body.userId, units: body.units, idempotencyKey: body.idempotencyKey, fingerprint },
        });
        return { reservationId: reservation.id };
      });
      req.log.info({ event: 'reservation.created', itemId, userId: body.userId, units: body.units }, 'reservation created');
      return reply.code(201).send({ status: 'reserved', reservationId: result.reservationId });
    } catch (e) {
      if (e instanceof ReserveError) return reply.code(e.code).send({ error: e.message });
      if (isUniqueViolation(e)) {
        const existing = await prisma.reservation.findUnique({ where: { idempotencyKey: body.idempotencyKey } });
        if (existing) {
          if (existing.fingerprint === fingerprint) {
            req.log.info({ event: 'reservation.idempotent_replay', idempotencyKey: body.idempotencyKey }, 'idempotent replay');
            return reply.code(200).send({ status: 'duplicate_ignored', reservationId: existing.id });
          }
          return reply.code(409).send({ error: 'idempotency_key_conflict' });
        }
      }
      throw e;
    }
  });

  app.post('/reservations/:id/release', async (req, reply) => {
    const { id: resId } = z.object({ id: z.string() }).parse(req.params);
    const reservation = await prisma.reservation.findUnique({ where: { id: resId } });
    if (!reservation) return reply.code(404).send({ error: 'reservation_not_found' });
    if (reservation.status === 'released') return reply.code(200).send({ status: 'already_released' });

    await prisma.$transaction(async (tx) => {
      await tx.reservation.update({ where: { id: resId }, data: { status: 'released' } });
      await tx.inventoryItem.update({ where: { id: reservation.itemId }, data: { reservedUnits: { decrement: reservation.units } } });
    });

    req.log.info({ event: 'reservation.released', reservationId: resId }, 'reservation released');
    return reply.code(200).send({ status: 'released' });
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'validation_error', details: err.flatten() });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal_error' });
  });

  return app;
}

class ReserveError extends Error {
  constructor(public code: number, message: string) { super(message); }
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
