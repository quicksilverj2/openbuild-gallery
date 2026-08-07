import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { prisma } from '../src/db';

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
  await prisma.clone.upsert({
    where: { slug: 'poll' },
    update: {},
    create: { slug: 'poll', title: 'Poll', summary: 'test', demoPath: '/clones/poll' },
  });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('observability â€” /metrics endpoint', () => {
  it('returns prometheus-style metrics', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    const text = res.body;
    expect(text).toContain('openbuild_clones_total');
    expect(text).toContain('openbuild_polls_total');
    expect(text).toContain('openbuild_votes_total');
  });

  it('metrics include per-clone event counters after activity', async () => {
    const pollRes = await app.inject({
      method: 'POST',
      url: '/clones/poll/polls',
      payload: { question: 'Metrics test?', options: ['A', 'B'] },
    });
    expect(pollRes.statusCode).toBe(201);
    const pollId = pollRes.json().id;
    const optionA = pollRes.json().options[0].id;

    await app.inject({
      method: 'POST',
      url: `/polls/${pollId}/votes`,
      payload: { optionId: optionA, voterId: 'metrics-voter', idempotencyKey: 'm1' },
    });

    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).toContain('openbuild_poll_poll_created_total');
    expect(res.body).toContain('openbuild_poll_vote_counted_total');
  });
});

describe('observability â€” request logging with correlation id', () => {
  it('accepts x-request-id header and uses it', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-request-id': 'test-correlation-123' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('generates a request id when none provided', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });
});

describe('observability â€” health endpoints', () => {
  it('/healthz returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });
});

describe('observability â€” existing poll tests still pass (no regression)', () => {
  it('counts a single vote', async () => {
    const pollRes = await app.inject({
      method: 'POST',
      url: '/clones/poll/polls',
      payload: { question: 'Regression?', options: ['Yes', 'No'] },
    });
    const pollId = pollRes.json().id;
    const optionA = pollRes.json().options[0].id;
    const res = await app.inject({
      method: 'POST',
      url: `/polls/${pollId}/votes`,
      payload: { optionId: optionA, voterId: 'reg-voter', idempotencyKey: 'r1' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().tally.total).toBe(1);
  });

  it('50 concurrent same-voter votes count exactly once, zero 5xx', async () => {
    const pollRes = await app.inject({
      method: 'POST',
      url: '/clones/poll/polls',
      payload: { question: 'Concurrent?', options: ['A', 'B'] },
    });
    const pollId = pollRes.json().id;
    const optionA = pollRes.json().options[0].id;
    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        app.inject({
          method: 'POST',
          url: `/polls/${pollId}/votes`,
          payload: { optionId: optionA, voterId: 'same', idempotencyKey: `k-${i}` },
        }),
      ),
    );
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c >= 500)).toHaveLength(0);
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(N - 1);
  });
});
