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

function shorten(payload: { url: string; alias?: string }) {
  return app.inject({ method: 'POST', url: '/shorten', payload });
}

function distribution(codes: number[]): Record<number, number> {
  return codes.reduce<Record<number, number>>((acc, c) => {
    acc[c] = (acc[c] ?? 0) + 1;
    return acc;
  }, {});
}

/** Unique URL per test so concurrent suites don't share rows. */
function uniqueUrl(tag: string): string {
  return `https://example.com/${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

describe('shortlink — happy path', () => {
  it('creates a short code and redirects to the target URL', async () => {
    const url = uniqueUrl('happy');
    const res = await shorten({ url });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.code).toMatch(/^[0-9A-Za-z]{8}$/);
    expect(body.url).toBe(url);
    expect(body.created).toBe(true);

    const redirect = await app.inject({ method: 'GET', url: `/${body.code}` });
    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers.location).toBe(url);
  });

  it('accepts an explicit alias as the code', async () => {
    const url = uniqueUrl('alias');
    const alias = `a${Math.random().toString(36).slice(2, 10)}`;
    const res = await shorten({ url, alias });
    expect(res.statusCode).toBe(201);
    expect(res.json().code).toBe(alias);

    const redirect = await app.inject({ method: 'GET', url: `/${alias}` });
    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers.location).toBe(url);
  });

  it('404s unknown codes', async () => {
    const res = await app.inject({ method: 'GET', url: '/no-such-code-zzzz' });
    expect(res.statusCode).toBe(404);
  });

  it('dedupes identical URLs on sequential calls', async () => {
    const url = uniqueUrl('dedupe');
    const first = await shorten({ url });
    expect(first.statusCode).toBe(201);
    const second = await shorten({ url });
    expect(second.statusCode).toBe(200);
    expect(second.json().code).toBe(first.json().code);
    expect(second.json().created).toBe(false);
  });
});

describe('invariant: concurrent /shorten of the same URL → one code, zero 5xx', () => {
  it('20 concurrent shortens of the same URL produce exactly one code', async () => {
    const url = uniqueUrl('burst-url');
    const N = 20;
    const results = await Promise.all(Array.from({ length: N }, () => shorten({ url })));
    const codes = results.map((r) => r.statusCode);
    const dist = distribution(codes);

    expect(codes.filter((c) => c >= 500)).toHaveLength(0);
    // Exactly one 201 (winner) and N-1 200 (resolved to winner), or all resolve
    // if a prior write landed — either way every body shares one code.
    const bodies = results.map((r) => r.json() as { code: string });
    const uniqueCodes = new Set(bodies.map((b) => b.code));
    expect(uniqueCodes.size).toBe(1);
    expect((dist[201] ?? 0) + (dist[200] ?? 0)).toBe(N);

    const only = bodies[0]!.code;
    const rows = await prisma.shortLink.findMany({ where: { url } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.code).toBe(only);

    const redirect = await app.inject({ method: 'GET', url: `/${only}` });
    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers.location).toBe(url);
  });
});

describe('invariant: concurrent /shorten of the same alias → one code, zero 5xx', () => {
  it('20 concurrent shortens with the same alias resolve to one row', async () => {
    const alias = `x${Math.random().toString(36).slice(2, 12)}`;
    // Same URL + same alias: classic race for the bounty gate.
    const url = uniqueUrl('burst-alias');
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, () => shorten({ url, alias })),
    );
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c >= 500)).toHaveLength(0);

    const bodies = results.map((r) => r.json() as { code: string });
    const uniqueCodes = new Set(bodies.map((b) => b.code));
    expect(uniqueCodes.size).toBe(1);
    expect([...uniqueCodes][0]).toBe(alias);

    const rows = await prisma.shortLink.findMany({ where: { code: alias } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.url).toBe(url);
  });
});

describe('shortlink — codes are non-enumerable', () => {
  it('generated codes are not sequential integers', async () => {
    const a = await shorten({ url: uniqueUrl('enum-a') });
    const b = await shorten({ url: uniqueUrl('enum-b') });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    const ca = a.json().code as string;
    const cb = b.json().code as string;
    expect(ca).not.toBe(cb);
    // Not pure decimal sequences like "1", "2"
    expect(/^\d+$/.test(ca) && /^\d+$/.test(cb) && Math.abs(Number(ca) - Number(cb)) === 1).toBe(
      false,
    );
  });
});
