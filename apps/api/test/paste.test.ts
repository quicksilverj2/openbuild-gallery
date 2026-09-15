import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { prisma } from '../src/db';

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

function createPaste(payload: Record<string, any>) {
  return app.inject({ method: 'POST', url: '/pastes', payload });
}

function readPaste(id: string) {
  return app.inject({ method: 'GET', url: `/pastes/${id}` });
}

describe('paste — happy path', () => {
  it('creates a paste with views and ttl', async () => {
    const res = await createPaste({
      content: 'Hello World',
      views_allowed: 3,
      ttl_seconds: 3600,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeDefined();
  });

  it('returns 400 for invalid body', async () => {
    const res = await createPaste({ content: 'test' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects non-string content', async () => {
    const res = await createPaste({
      content: 123,
      views_allowed: 1,
      ttl_seconds: 3600,
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects views_allowed <= 0', async () => {
    const res = await createPaste({
      content: 'test',
      views_allowed: 0,
      ttl_seconds: 3600,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('paste — read and consume', () => {
  it('reads a paste and decrements views', async () => {
    const createRes = await createPaste({
      content: 'test content',
      views_allowed: 2,
      ttl_seconds: 3600,
    });
    const { id } = createRes.json();

    const readRes = await readPaste(id);
    expect(readRes.statusCode).toBe(200);
    expect(readRes.body).toBe('test content');

    // Second read should also succeed
    const readRes2 = await readPaste(id);
    expect(readRes2.statusCode).toBe(200);
    expect(readRes2.body).toBe('test content');

    // Third read should 410 (views exhausted — 410 not 404 because the paste exists but is consumed)
    const readRes3 = await readPaste(id);
    expect(readRes3.statusCode).toBe(410);
  });

  it('returns 404 for non-existent paste', async () => {
    const res = await readPaste('00000000-0000-0000-0000-000000000000');
    expect(res.statusCode).toBe(404);
  });
});

describe('invariant: 20 concurrent reads of 1-view paste', () => {
  it('exactly one read succeeds, the rest get 404', async () => {
    const createRes = await createPaste({
      content: 'race test',
      views_allowed: 1,
      ttl_seconds: 3600,
    });
    const { id } = createRes.json();

    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, () => readPaste(id))
    );

    const statusCodes = results.map((r) => r.statusCode);
    const successes = statusCodes.filter((c) => c === 200);
    // 404 = not found, 410 = consumed/expired — both are non-200 failures
    const failures = statusCodes.filter((c) => c === 404 || c === 410);

    // No 5xx errors
    expect(statusCodes.filter((c) => c >= 500)).toHaveLength(0);

    // Exactly one success
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(N - 1);

    // The successful read got the content
    expect(results.find((r) => r.statusCode === 200)?.body).toBe('race test');
  });
});
