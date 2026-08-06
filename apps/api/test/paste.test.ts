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

function createPaste(payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/paste', payload });
}

function readPaste(id: string) {
  return app.inject({ method: 'GET', url: `/paste/${id}` });
}

function distribution(codes: number[]): Record<number, number> {
  return codes.reduce<Record<number, number>>((acc, c) => {
    acc[c] = (acc[c] ?? 0) + 1;
    return acc;
  }, {});
}

const RUN = `${Date.now().toString(36)}`;

describe('paste — happy path', () => {
  it('creates and reads a paste', async () => {
    const create = await createPaste({ content: 'hello world' });
    expect(create.statusCode).toBe(201);
    expect(create.json().id).toBeTruthy();
    expect(create.json().viewsAllowed).toBe(1);
    expect(create.json().viewsUsed).toBe(0);

    const read = await readPaste(create.json().id);
    expect(read.statusCode).toBe(200);
    expect(read.json().content).toBe('hello world');
    expect(read.json().viewsUsed).toBe(1);
  });

  it('returns 410 after views are exhausted', async () => {
    const create = await createPaste({ content: 'one-shot', viewsAllowed: 1 });
    expect(create.statusCode).toBe(201);

    // First read succeeds
    const first = await readPaste(create.json().id);
    expect(first.statusCode).toBe(200);

    // Second read fails with 410 (exhausted)
    const second = await readPaste(create.json().id);
    expect(second.statusCode).toBe(410);
    expect(second.json().error).toBe('paste_exhausted');
  });

  it('supports multi-view pastes', async () => {
    const create = await createPaste({ content: 'multi', viewsAllowed: 3 });
    expect(create.statusCode).toBe(201);

    for (let i = 0; i < 3; i++) {
      const read = await readPaste(create.json().id);
      expect(read.statusCode).toBe(200);
      expect(read.json().viewsUsed).toBe(i + 1);
    }

    // Fourth read exhausted
    const exhausted = await readPaste(create.json().id);
    expect(exhausted.statusCode).toBe(410);
    expect(exhausted.json().error).toBe('paste_exhausted');
  });

  it('returns 404 for unknown paste', async () => {
    const res = await readPaste(`no-such-paste-${RUN}`);
    expect(res.statusCode).toBe(404);
  });

  it('returns 410 for expired paste', async () => {
    // Create paste with 1 second TTL
    const create = await createPaste({ content: 'ephemeral', ttlSeconds: 1 });
    expect(create.statusCode).toBe(201);

    // Wait for expiration
    await new Promise((r) => setTimeout(r, 1100));

    const read = await readPaste(create.json().id);
    expect(read.statusCode).toBe(410);
    expect(read.json().error).toBe('paste_expired');
  });
});

describe('invariant: concurrent reads of a 1-view paste', () => {
  it('20 concurrent reads of a 1-view paste → exactly one gets content, rest 410, zero 5xx', async () => {
    const create = await createPaste({ content: 'concurrent-one-view', viewsAllowed: 1 });
    expect(create.statusCode).toBe(201);
    const pasteId = create.json().id;

    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, () => readPaste(pasteId)),
    );
    const codes = results.map((r) => r.statusCode);
    const dist = distribution(codes);

    // zero 5xx
    expect(codes.filter((c) => c >= 500)).toHaveLength(0);

    // exactly one read gets content (200)
    expect(dist[200] ?? 0).toBe(1);

    // the rest get 410
    expect(dist[410] ?? 0).toBe(N - 1);
  });
});

describe('invariant: concurrent reads of a 5-view paste', () => {
  it('20 concurrent reads of a 5-view paste → exactly 5 get content, rest 410, zero 5xx', async () => {
    const create = await createPaste({ content: 'concurrent-five-view', viewsAllowed: 5 });
    expect(create.statusCode).toBe(201);
    const pasteId = create.json().id;

    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, () => readPaste(pasteId)),
    );
    const codes = results.map((r) => r.statusCode);
    const dist = distribution(codes);

    // zero 5xx
    expect(codes.filter((c) => c >= 500)).toHaveLength(0);

    // exactly 5 reads get content (200)
    expect(dist[200] ?? 0).toBe(5);

    // the rest get 410
    expect(dist[410] ?? 0).toBe(N - 5);
  });
});
