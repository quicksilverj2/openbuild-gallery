import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { prisma } from '../src/db';

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
  await prisma.clone.upsert({
    where: { slug: 'shortlink' },
    update: {},
    create: {
      slug: 'shortlink',
      title: 'Shortlink',
      summary: 'test',
      demoPath: '/clones/shortlink',
    },
  });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function createShortlink(url: string, alias?: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/clones/shortlink/shortlinks',
    payload: { url, alias },
  });
  return res;
}

function getShortlink(code: string) {
  return app.inject({ method: 'GET', url: `/shortlinks/${code}/info` });
}

function redirect(code: string) {
  return app.inject({ method: 'GET', url: `/shortlinks/${code}` });
}

function distribution(codes: number[]) {
  return codes.reduce<Record<number, number>>((acc, c) => {
    acc[c] = (acc[c] ?? 0) + 1;
    return acc;
  }, {});
}

describe('shortlink - happy path', () => {
  it('creates a shortlink and returns code + url', async () => {
    const res = await createShortlink('https://example.com/foo');
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.code).toBeDefined();
    expect(body.url).toBe('https://example.com/foo');
  });

  it('includes alias when provided', async () => {
    const res = await createShortlink('https://example.com/bar', 'myalias');
    expect(res.statusCode).toBe(201);
    const { code } = res.json();
    const info = await getShortlink(code);
    expect(info.json().alias).toBe('myalias');
  });

  it('404s an unknown code', async () => {
    const res = await app.inject({ method: 'GET', url: '/shortlinks/nonexistent/info' });
    expect(res.statusCode).toBe(404);
  });

  it('redirects to the original url', async () => {
    const { code } = (await createShortlink('https://example.com/redirect-me')).json();
    const res = await redirect(code);
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe('https://example.com/redirect-me');
  });

  it('404s for unknown clone slug', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/clones/nonexistent/shortlinks',
      payload: { url: 'https://example.com' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('invariant: url deduplication', () => {
  it('second create with same url returns 409', async () => {
    const first = await createShortlink('https://example.com/dedup');
    expect(first.statusCode).toBe(201);
    const second = await createShortlink('https://example.com/dedup');
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('url_already_shortened');
    expect(second.json().code).toBe(first.json().code);
  });
});

describe('invariant: alias deduplication', () => {
  it('second create with same alias returns 409', async () => {
    const first = await createShortlink('https://example.com/a1', 'shared-alias');
    expect(first.statusCode).toBe(201);
    const second = await createShortlink('https://example.com/a2', 'shared-alias');
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('alias_already_taken');
  });
});

describe('invariant: concurrent same-url burst', () => {
  it('50 concurrent identical-url requests: exactly one 201, rest 409, zero 5xx', async () => {
    const N = 50;
    const url = 'https://example.com/burst-same';
    const results = await Promise.all(Array.from({ length: N }, () => createShortlink(url)));
    const codes = results.map((r) => r.statusCode);
    const dist = distribution(codes);

    expect(codes.filter((c) => c >= 500)).toHaveLength(0);
    expect(dist[201]).toBe(1);
    expect(dist[409]).toBe(N - 1);

    const winner = results.find((r) => r.statusCode === 201);
    if (!winner) throw new Error('no winner');
    const winnerCode = winner.json().code;
    const info = await getShortlink(winnerCode);
    expect(info.statusCode).toBe(200);
    expect(info.json().url).toBe(url);
  });
});

describe('invariant: concurrent different-url burst', () => {
  it('50 concurrent distinct-url requests all get 201 with unique codes', async () => {
    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => createShortlink(`https://example.com/distinct-${i}`)),
    );
    const codes = results.map((r) => r.statusCode);

    expect(codes.filter((c) => c >= 500)).toHaveLength(0);
    expect(codes.filter((c) => c === 201)).toHaveLength(N);

    const createdCodes = results.map((r) => r.json().code);
    expect(new Set(createdCodes).size).toBe(N);
  });
});
