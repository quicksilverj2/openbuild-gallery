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

async function newPaste(viewsAllowed: number, ttlSeconds = 60): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/clones/paste/pastes',
    payload: { content: 'secret text', viewsAllowed, ttlSeconds },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

const read = (id: string) => app.inject({ method: 'GET', url: `/pastes/${id}` });

describe('paste: basics', () => {
  it('serves content and then 404s once views are exhausted', async () => {
    const id = await newPaste(2);
    expect((await read(id)).statusCode).toBe(200);
    expect((await read(id)).json().content).toBe('secret text');
    expect((await read(id)).statusCode).toBe(404);
  });

  it('404s an unknown id and an expired paste', async () => {
    expect((await read('does-not-exist')).statusCode).toBe(404);
    const id = await newPaste(5, 1);
    await new Promise((r) => setTimeout(r, 1200));
    expect((await read(id)).statusCode).toBe(404);
  });

  it('rejects invalid bodies with 400', async () => {
    for (const payload of [
      { content: '', viewsAllowed: 1, ttlSeconds: 10 },
      { content: 'x', viewsAllowed: 0, ttlSeconds: 10 },
      { content: 'x', viewsAllowed: 1, ttlSeconds: 0 },
      { content: 'x', viewsAllowed: 1.5, ttlSeconds: 10 },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/clones/paste/pastes', payload });
      expect(res.statusCode).toBe(400);
    }
  });
});

describe('invariant: limited views under a concurrent burst', () => {
  it('20 concurrent reads of a 1-view paste: exactly ONE served, zero 5xx', async () => {
    const id = await newPaste(1);
    const results = await Promise.all(Array.from({ length: 20 }, () => read(id)));
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c >= 500)).toHaveLength(0);
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 404)).toHaveLength(19);
    expect(results.filter((r) => r.statusCode === 200)[0]!.json().content).toBe('secret text');
  });

  it('50 concurrent reads of a 5-view paste: exactly five served', async () => {
    const id = await newPaste(5);
    const results = await Promise.all(Array.from({ length: 50 }, () => read(id)));
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c >= 500)).toHaveLength(0);
    expect(codes.filter((c) => c === 200)).toHaveLength(5);
  });
});
