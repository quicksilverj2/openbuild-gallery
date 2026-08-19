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
    create: {
      slug: 'paste',
      title: 'Paste (view-once)',
      summary: 'Self-destructing pastes with atomic read counter',
      demoPath: '/clones/paste',
    },
  });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function newPaste(content: string, viewsAllowed: number = 1, ttlSeconds?: number) {
  const res = await app.inject({
    method: 'POST',
    url: '/clones/paste/pastes',
    payload: { content, viewsAllowed, ttlSeconds },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

function readPaste(id: string) {
  return app.inject({ method: 'GET', url: `/pastes/${id}` });
}

describe('paste clone — basic lifecycle', () => {
  it('creates and reads a single-view paste', async () => {
    const paste = await newPaste('Secret message 123', 1);
    expect(paste.id).toBeDefined();
    expect(paste.viewsAllowed).toBe(1);

    const firstRead = await readPaste(paste.id);
    expect(firstRead.statusCode).toBe(200);
    expect(firstRead.json().content).toBe('Secret message 123');
    expect(firstRead.json().viewsLeft).toBe(0);

    // Second read must return 404
    const secondRead = await readPaste(paste.id);
    expect(secondRead.statusCode).toBe(404);
  });

  it('handles multi-view paste correctly', async () => {
    const paste = await newPaste('Multi-view token', 3);
    expect(paste.viewsAllowed).toBe(3);

    const r1 = await readPaste(paste.id);
    expect(r1.statusCode).toBe(200);
    expect(r1.json().viewsLeft).toBe(2);

    const r2 = await readPaste(paste.id);
    expect(r2.statusCode).toBe(200);
    expect(r2.json().viewsLeft).toBe(1);

    const r3 = await readPaste(paste.id);
    expect(r3.statusCode).toBe(200);
    expect(r3.json().viewsLeft).toBe(0);

    const r4 = await readPaste(paste.id);
    expect(r4.statusCode).toBe(404);
  });
});

describe('invariant: concurrent reads of view-once paste', () => {
  it('20 concurrent reads of a 1-view paste → exactly ONE 200, 19 404s, zero 5xx', async () => {
    const paste = await newPaste('Highly confidential atomic payload', 1);
    const N = 20;

    const results = await Promise.all(Array.from({ length: N }, () => readPaste(paste.id)));

    const codes = results.map((r) => r.statusCode);
    const count200 = codes.filter((c) => c === 200).length;
    const count404 = codes.filter((c) => c === 404).length;
    const count5xx = codes.filter((c) => c >= 500).length;

    expect(count5xx).toBe(0); // Zero 5xx under race
    expect(count200).toBe(1); // Exactly one reader got the content
    expect(count404).toBe(N - 1); // Remaining 19 got 404

    const winner = results.find((r) => r.statusCode === 200)?.json();
    expect(winner.content).toBe('Highly confidential atomic payload');
  });

  it('20 concurrent reads of a 5-view paste → exactly 5 200s, 15 404s, zero 5xx', async () => {
    const paste = await newPaste('5-view distributed secret', 5);
    const N = 20;

    const results = await Promise.all(Array.from({ length: N }, () => readPaste(paste.id)));

    const codes = results.map((r) => r.statusCode);
    const count200 = codes.filter((c) => c === 200).length;
    const count404 = codes.filter((c) => c === 404).length;
    const count5xx = codes.filter((c) => c >= 500).length;

    expect(count5xx).toBe(0);
    expect(count200).toBe(5);
    expect(count404).toBe(15);
  });
});
