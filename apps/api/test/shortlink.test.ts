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
    create: { slug: 'shortlink', title: 'Shortlink', summary: 'test', demoPath: '/clones/shortlink' },
  });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

function shorten(payload: Record<string, string>) {
  return app.inject({ method: 'POST', url: '/shorten', payload });
}

function distribution(codes: number[]): Record<number, number> {
  return codes.reduce<Record<number, number>>((acc, c) => {
    acc[c] = (acc[c] ?? 0) + 1;
    return acc;
  }, {});
}

const RUN = `${Date.now().toString(36)}`;

describe('shortlink — happy path', () => {
  it('creates a shortlink and redirects', async () => {
    const url = `https://example.com/${RUN}-happy`;
    const res = await shorten({ url });
    expect(res.statusCode).toBe(201);
    expect(res.json().code).toBeTruthy();
    expect(res.json().url).toBe(url);

    const redir = await app.inject({ method: 'GET', url: `/s/${res.json().code}` });
    expect(redir.statusCode).toBe(302);
    expect(redir.headers.location).toBe(url);
  });

  it('deduplicates identical URLs', async () => {
    const url = `https://example.com/${RUN}-dedup`;
    const first = await shorten({ url });
    expect(first.statusCode).toBe(201);
    const second = await shorten({ url });
    expect(second.statusCode).toBe(200);
    expect(second.json().code).toBe(first.json().code);
    expect(second.json().url).toBe(url);
  });

  it('supports custom aliases', async () => {
    const alias = `my-link-${RUN}`;
    const url = `https://example.com/${RUN}-alias`;
    const res = await shorten({ url, alias });
    expect(res.statusCode).toBe(201);
    expect(res.json().code).toBe(alias);
    expect(res.json().url).toBe(url);
  });

  it('returns 409 when alias is already taken by a different URL', async () => {
    const alias = `conflict-${RUN}`;
    const url1 = `https://a.example.com/${RUN}`;
    const url2 = `https://b.example.com/${RUN}`;
    const first = await shorten({ url: url1, alias });
    expect(first.statusCode).toBe(201);
    const second = await shorten({ url: url2, alias });
    expect(second.statusCode).toBe(409);
  });

  it('returns 200 when alias is reused for the same URL (idempotent)', async () => {
    const alias = `idem-${RUN}`;
    const url = `https://example.com/${RUN}-idem`;
    const first = await shorten({ url, alias });
    expect(first.statusCode).toBe(201);
    const second = await shorten({ url, alias });
    expect(second.statusCode).toBe(200);
    expect(second.json().code).toBe(alias);
  });

  it('returns 404 for unknown shortlinks', async () => {
    const res = await app.inject({ method: 'GET', url: `/s/no-such-code-${RUN}` });
    expect(res.statusCode).toBe(404);
  });
});

describe('invariant: concurrent /shorten of same URL deduplicates', () => {
  it('20 concurrent /shorten → exactly one code, zero 5xx', async () => {
    const url = `https://example.com/${RUN}-concurrent`;
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, () => shorten({ url })),
    );
    const codes = results.map((r) => r.statusCode);
    const dist = distribution(codes);

    expect(codes.filter((c) => c >= 500)).toHaveLength(0); // no server errors
    expect(dist[201]).toBe(1); // exactly one created

    // All responses must return the same code
    const shortCodes = new Set(results.filter((r) => r.json()?.code).map((r) => r.json().code));
    expect(shortCodes.size).toBe(1);
  });
});

describe('invariant: concurrent /shorten with same alias', () => {
  it('20 concurrent alias claims → all but first get 409, zero 5xx', async () => {
    const alias = `burst-alias-${RUN}`;
    const url1 = `https://u1.example.com/${RUN}`;
    const url2 = `https://u2.example.com/${RUN}`;

    // First claim the alias
    const first = await shorten({ url: url1, alias });
    expect(first.statusCode).toBe(201);

    // Burst with different URL
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, () => shorten({ url: url2, alias })),
    );
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c >= 500)).toHaveLength(0);
    expect(codes.filter((c) => c === 409)).toHaveLength(N);
  });
});
