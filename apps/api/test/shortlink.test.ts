import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
      summary: 'URL shortener clone',
      demoPath: '/clones/shortlink',
    },
  });
});

beforeEach(async () => {
  await prisma.shortlink.deleteMany();
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

describe('shortlink — happy path', () => {
  it('creates a shortlink and redirects', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/shorten',
      payload: { url: 'https://openbuild.xyz/docs' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.url).toBe('https://openbuild.xyz/docs');
    expect(typeof body.code).toBe('string');
    expect(body.code.length).toBeGreaterThanOrEqual(6);

    const redirectRes = await app.inject({
      method: 'GET',
      url: `/${body.code}`,
    });
    expect(redirectRes.statusCode).toBe(307);
    expect(redirectRes.headers.location).toBe('https://openbuild.xyz/docs');
  });

  it('creates a shortlink with a custom alias and redirects', async () => {
    const alias = `custom-${Date.now().toString(36)}`;
    const res = await app.inject({
      method: 'POST',
      url: '/shorten',
      payload: { url: 'https://openbuild.xyz/community', alias },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.code).toBe(alias);
    expect(body.url).toBe('https://openbuild.xyz/community');

    const redirectRes = await app.inject({
      method: 'GET',
      url: `/${alias}`,
    });
    expect(redirectRes.statusCode).toBe(307);
    expect(redirectRes.headers.location).toBe('https://openbuild.xyz/community');
  });

  it('returns 404 for nonexistent code', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/nonexistent-code-404',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('shortlink_not_found');
  });
});

describe('shortlink — deduplication', () => {
  it('subsequent POST for same URL returns existing code with 200', async () => {
    const url = `https://example.com/item-${Date.now().toString(36)}`;
    const first = await app.inject({
      method: 'POST',
      url: '/shorten',
      payload: { url },
    });
    expect(first.statusCode).toBe(201);
    const firstCode = first.json().code;

    const second = await app.inject({
      method: 'POST',
      url: '/shorten',
      payload: { url },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().code).toBe(firstCode);
  });
});

describe('shortlink — validation & error handling', () => {
  it('rejects invalid URL with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/shorten',
      payload: { url: 'not-a-valid-url' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('rejects invalid alias with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/shorten',
      payload: { url: 'https://example.com', alias: 'invalid alias with spaces!' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('rejects duplicate alias with different URL with 409', async () => {
    const alias = `conflict-${Date.now().toString(36)}`;
    const first = await app.inject({
      method: 'POST',
      url: '/shorten',
      payload: { url: 'https://url-one.com', alias },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: '/shorten',
      payload: { url: 'https://url-two.com', alias },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('alias_already_taken');
  });
});

describe('invariant: 20 concurrent /shorten of the same URL', () => {
  it('20 concurrent /shorten of same URL -> exactly one code wins, rest resolve to it, zero 5xx', async () => {
    const N = 20;
    const url = `https://invariant.test/race-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        app.inject({
          method: 'POST',
          url: '/shorten',
          payload: { url },
        }),
      ),
    );

    const statuses = results.map((r) => r.statusCode);
    const dist = distribution(statuses);

    expect(statuses.filter((s) => s >= 500)).toHaveLength(0);
    expect(dist[201]).toBe(1);
    expect(dist[200]).toBe(N - 1);

    const codes = new Set(results.map((r) => r.json().code));
    expect(codes.size).toBe(1);

    const count = await prisma.shortlink.count({
      where: { url },
    });
    expect(count).toBe(1);
  });
});

describe('invariant: 20 concurrent /shorten of the same alias', () => {
  it('20 concurrent /shorten of same alias -> exactly one wins (201), rest resolve (200), zero 5xx', async () => {
    const N = 20;
    const alias = `burst-alias-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const url = `https://invariant.test/alias-${alias}`;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        app.inject({
          method: 'POST',
          url: '/shorten',
          payload: { url, alias },
        }),
      ),
    );

    const statuses = results.map((r) => r.statusCode);
    const dist = distribution(statuses);

    expect(statuses.filter((s) => s >= 500)).toHaveLength(0);
    expect(dist[201]).toBe(1);
    expect(dist[200]).toBe(N - 1);

    const codes = new Set(results.map((r) => r.json().code));
    expect(codes.size).toBe(1);
    expect(Array.from(codes)[0]).toBe(alias);
  });
});
