import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { prisma } from '../src/db';

let app: FastifyInstance;

beforeAll(async () => {
  process.env.RATE_LIMIT_CAPACITY = '5';
  process.env.RATE_LIMIT_REFILL = '0.1';
  app = buildApp();
  await app.ready();
  await prisma.clone.upsert({
    where: { slug: 'poll' },
    update: {},
    create: { slug: 'poll', title: 'Poll', summary: 'test', demoPath: '/clones/poll' },
  });
  await prisma.rateLimitState.deleteMany();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

function distribution(codes: number[]): Record<number, number> {
  return codes.reduce<Record<number, number>>((acc, c) => {
    acc[c] = (acc[c] ?? 0) + 1;
    return acc;
  }, {});
}

describe('rate limiter â€” token bucket correctness', () => {
  it('allows exactly C requests then 429s the rest under a burst, zero 5xx', async () => {
    const N = 20;
    const apiKey = `burst-${Date.now()}`;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        app.inject({
          method: 'POST',
          url: '/clones/poll/polls',
          headers: { 'x-api-key': apiKey },
          payload: { question: 'Rate limit test?', options: ['A', 'B'] },
        }),
      ),
    );
    const codes = results.map((r) => r.statusCode);
    const dist = distribution(codes);

    expect(codes.filter((c) => c >= 500)).toHaveLength(0);
    expect(dist[201]).toBe(5);
    expect(dist[429]).toBe(15);
  });

  it('rate limit headers are set', async () => {
    const apiKey = `headers-${Date.now()}`;
    const res = await app.inject({
      method: 'POST',
      url: '/clones/poll/polls',
      headers: { 'x-api-key': apiKey },
      payload: { question: 'Header test?', options: ['A', 'B'] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers['x-ratelimit-limit']).toBeTruthy();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
  });

  it('429 response includes retryAfter', async () => {
    const apiKey = `retry-${Date.now()}`;
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: 'POST',
        url: '/clones/poll/polls',
        headers: { 'x-api-key': apiKey },
        payload: { question: `Fill ${i}?`, options: ['A', 'B'] },
      });
    }
    const res = await app.inject({
      method: 'POST',
      url: '/clones/poll/polls',
      headers: { 'x-api-key': apiKey },
      payload: { question: 'Over limit?', options: ['A', 'B'] },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe('rate_limit_exceeded');
    expect(res.json().retryAfter).toBeDefined();
  });
});

describe('rate limiter â€” different keys are independent', () => {
  it('key A hitting limit does not affect key B', async () => {
    const keyA = `indep-a-${Date.now()}`;
    const keyB = `indep-b-${Date.now()}`;

    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: 'POST',
        url: '/clones/poll/polls',
        headers: { 'x-api-key': keyA },
        payload: { question: `A ${i}?`, options: ['A', 'B'] },
      });
    }

    const aRes = await app.inject({
      method: 'POST',
      url: '/clones/poll/polls',
      headers: { 'x-api-key': keyA },
      payload: { question: 'A over?', options: ['A', 'B'] },
    });
    expect(aRes.statusCode).toBe(429);

    const bRes = await app.inject({
      method: 'POST',
      url: '/clones/poll/polls',
      headers: { 'x-api-key': keyB },
      payload: { question: 'B ok?', options: ['A', 'B'] },
    });
    expect(bRes.statusCode).toBe(201);
  });
});

describe('rate limiter â€” no regression on GET routes', () => {
  it('GET routes are not rate limited', async () => {
    const apiKey = `get-${Date.now()}`;
    for (let i = 0; i < 20; i++) {
      await app.inject({
        method: 'GET',
        url: '/clones',
        headers: { 'x-api-key': apiKey },
      });
    }
    const res = await app.inject({
      method: 'GET',
      url: '/clones',
      headers: { 'x-api-key': apiKey },
    });
    expect(res.statusCode).toBe(200);
  });
});
