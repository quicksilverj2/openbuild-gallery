import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { prisma } from '../src/db';

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
  await prisma.clone.upsert({
    where: { slug: 'paste' },
    update: {},
    create: { slug: 'paste', title: 'Paste', summary: 'test', demoPath: '/clones/paste' },
  });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function createPaste(
  content: string,
  viewsAllowed = 1,
  ttlSeconds = 3600,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/clones/paste/pastes',
    payload: { content, viewsAllowed, ttlSeconds },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

function readPaste(id: string) {
  return app.inject({ method: 'GET', url: `/pastes/${id}` });
}

describe('paste â€” happy path', () => {
  it('creates and reads a paste with 1 view', async () => {
    const id = await createPaste('secret message', 1, 3600);
    const res = await readPaste(id);
    expect(res.statusCode).toBe(200);
    expect(res.json().content).toBe('secret message');
    expect(res.json().viewsRemaining).toBe(0);
  });

  it('second read of a 1-view paste returns 410', async () => {
    const id = await createPaste('one-shot', 1, 3600);
    const first = await readPaste(id);
    expect(first.statusCode).toBe(200);
    const second = await readPaste(id);
    expect(second.statusCode).toBe(410);
    expect(second.json().error).toBe('paste_exhausted');
  });
});

describe('invariant: exactly N reads succeed under concurrent burst, zero 5xx', () => {
  it('20 concurrent reads of a 1-view paste -> exactly 1 success, 19 get 410', async () => {
    const id = await createPaste('race-test', 1, 3600);
    const N = 20;
    const results = await Promise.all(Array.from({ length: N }, () => readPaste(id)));
    const codes = results.map((r) => r.statusCode);

    expect(codes.filter((c) => c >= 500)).toHaveLength(0);
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 410)).toHaveLength(N - 1);
  });

  it('20 concurrent reads of a 5-view paste -> exactly 5 success, 15 get 410', async () => {
    const id = await createPaste('multi-view', 5, 3600);
    const N = 20;
    const results = await Promise.all(Array.from({ length: N }, () => readPaste(id)));
    const codes = results.map((r) => r.statusCode);

    expect(codes.filter((c) => c >= 500)).toHaveLength(0);
    expect(codes.filter((c) => c === 200)).toHaveLength(5);
    expect(codes.filter((c) => c === 410)).toHaveLength(15);
  });
});

describe('paste â€” TTL expiry', () => {
  it('expired paste returns 410', async () => {
    const id = await createPaste('expires-fast', 10, 1);
    // wait 2 seconds for expiry
    await new Promise((r) => setTimeout(r, 2000));
    const res = await readPaste(id);
    expect(res.statusCode).toBe(410);
    expect(res.json().error).toBe('paste_expired');
  });
});

describe('paste â€” validation', () => {
  it('rejects empty content with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/clones/paste/pastes',
      payload: { content: '', viewsAllowed: 1, ttlSeconds: 3600 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects viewsAllowed < 1 with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/clones/paste/pastes',
      payload: { content: 'test', viewsAllowed: 0, ttlSeconds: 3600 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('404 for non-existent paste', async () => {
    const res = await readPaste('nonexistent-id');
    expect(res.statusCode).toBe(404);
  });
});
