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
    create: { slug: 'paste', title: 'Paste', summary: 'paste', demoPath: '/clones/paste' },
  });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function newPaste(viewsAllowed: number): Promise<{ id: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/clones/paste/pastes',
    payload: { content: 'secret message', viewsAllowed },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

function readPaste(id: string) {
  return app.inject({ method: 'GET', url: /pastes/ + id });
}

describe('paste reading', () => {
  it('allows reading up to the views limit', async () => {
    const { id } = await newPaste(2);
    
    const res1 = await readPaste(id);
    expect(res1.statusCode).toBe(200);
    expect(res1.json().content).toBe('secret message');

    const res2 = await readPaste(id);
    expect(res2.statusCode).toBe(200);

    const res3 = await readPaste(id);
    expect(res3.statusCode).toBe(404);
  });
});

describe('invariant: concurrent reads never oversell', () => {
  it('20 concurrent reads of a 1-view paste count exactly once', async () => {
    const { id } = await newPaste(1);
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, () => readPaste(id)),
    );
    const codes = results.map((r) => r.statusCode);
    
    expect(codes.filter((c) => c >= 500)).toHaveLength(0); // zero 5xx
    expect(codes.filter((c) => c === 200)).toHaveLength(1); // exactly one winner
    expect(codes.filter((c) => c === 404)).toHaveLength(N - 1); // rest get 404
  });
});
