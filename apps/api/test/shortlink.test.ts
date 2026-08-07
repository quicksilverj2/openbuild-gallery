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

function shorten(url: string, alias?: string) {
  const payload: Record<string, string> = { url };
  if (alias) payload.alias = alias;
  return app.inject({ method: 'POST', url: '/clones/shortlink/shorten', payload });
}

function redirect(code: string) {
  return app.inject({ method: 'GET', url: `/s/${code}` });
}

describe('shortlink â€” happy path', () => {
  it('creates a shortlink and redirects', async () => {
    const res = await shorten('https://example.com/test1');
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.code).toBeTruthy();
    expect(body.url).toBe('https://example.com/test1');

    const redir = await redirect(body.code);
    expect(redir.statusCode).toBe(302);
    expect(redir.headers.location).toBe('https://example.com/test1');
  });

  it('creates a shortlink with a custom alias', async () => {
    const res = await shorten('https://example.com/aliased', 'mylink');
    expect(res.statusCode).toBe(201);
    expect(res.json().alias).toBe('mylink');

    const redir = await redirect('mylink');
    expect(redir.statusCode).toBe(302);
    expect(redir.headers.location).toBe('https://example.com/aliased');
  });
});

describe('invariant: dedup identical URLs under concurrent burst, zero 5xx', () => {
  it('20 concurrent /shorten of the same URL -> all get the same code, zero 5xx', async () => {
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, () => shorten('https://dedup-test.com')),
    );
    const codes = results.map((r) => r.json().code);
    const statusCodes = results.map((r) => r.statusCode);

    expect(statusCodes.filter((c) => c >= 500)).toHaveLength(0);
    const uniqueCodes = [...new Set(codes)];
    expect(uniqueCodes).toHaveLength(1);
  });

  it('20 concurrent /shorten of the same URL with same alias -> all resolve to one, zero 5xx', async () => {
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, () => shorten('https://alias-dedup.com', 'shared')),
    );
    const codes = results.map((r) => r.json().code);
    const statusCodes = results.map((r) => r.statusCode);

    expect(statusCodes.filter((c) => c >= 500)).toHaveLength(0);
    const uniqueCodes = [...new Set(codes)];
    expect(uniqueCodes).toHaveLength(1);
  });
});

describe('shortlink â€” error handling', () => {
  it('404 for non-existent code', async () => {
    const res = await redirect('nonexistent-code');
    expect(res.statusCode).toBe(404);
  });

  it('rejects empty URL with 400', async () => {
    const res = await shorten('');
    expect(res.statusCode).toBe(400);
  });

  it('alias taken by a different URL returns 409', async () => {
    await shorten('https://first-url.com', 'taken-alias');
    const res = await shorten('https://second-url.com', 'taken-alias');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('alias_taken');
  });
});
