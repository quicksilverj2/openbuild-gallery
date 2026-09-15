import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { prisma } from '../src/db';

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

function shorten(payload: Record<string, any>) {
  return app.inject({ method: 'POST', url: '/shorten', payload });
}

function redirect(code: string) {
  return app.inject({ method: 'GET', url: `/${code}` });
}

describe('shortlink — happy path', () => {
  it('creates a shortlink without alias', async () => {
    const res = await shorten({ url: 'https://example.com/happy-path-1' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.code).toBeDefined();
    expect(typeof body.code).toBe('string');
    expect(body.code.length).toBe(6);

    // Verify retrieval / redirect
    const rRes = await redirect(body.code);
    expect(rRes.statusCode).toBe(302);
    expect(rRes.headers.location).toBe('https://example.com/happy-path-1');
  });

  it('creates a shortlink with custom alias', async () => {
    const alias = `my-custom-alias-${Math.random().toString(36).slice(2, 8)}`;
    const res = await shorten({ url: 'https://example.com/happy-path-2', alias });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.code).toBeDefined();
    expect(body.code.length).toBe(6);

    // Verify lookup / redirect
    const rRes = await redirect(body.code);
    expect(rRes.statusCode).toBe(302);
    expect(rRes.headers.location).toBe('https://example.com/happy-path-2');
  });
});

describe('shortlink — validation and 404', () => {
  it('returns 400 for invalid URLs', async () => {
    const res = await shorten({ url: 'not-a-valid-url' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('returns 400 for invalid aliases containing bad characters', async () => {
    const res = await shorten({ url: 'https://example.com/valid', alias: 'invalid/alias' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('returns 404 for non-existent codes', async () => {
    const res = await redirect('nonexist');
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('shortlink_not_found');
  });
});

describe('invariant: 20 concurrent requests for same URL/alias', () => {
  it('exactly ONE code wins, the rest resolve to it with zero 5xx', async () => {
    const targetUrl = `https://example.com/race-${Math.random().toString(36).slice(2, 8)}`;
    const N = 20;

    const results = await Promise.all(
      Array.from({ length: N }, () => shorten({ url: targetUrl }))
    );

    const codes = results.map((r) => r.statusCode);
    const bodyCodes = results.map((r) => r.json().code);

    // No server errors
    expect(codes.filter((c) => c >= 500)).toHaveLength(0);

    // Exactly one winner gets 201 (created), other 19 get 200 (resolved existing)
    const success201 = codes.filter((c) => c === 201);
    const success200 = codes.filter((c) => c === 200);

    expect(success201).toHaveLength(1);
    expect(success200).toHaveLength(N - 1);

    // All returned codes are identical (exactly one code wins)
    const uniqueCodes = [...new Set(bodyCodes)];
    expect(uniqueCodes).toHaveLength(1);

    // Verify lookup is correct
    const rRes = await redirect(uniqueCodes[0]);
    expect(rRes.statusCode).toBe(302);
    expect(rRes.headers.location).toBe(targetUrl);
  });

  it('exactly ONE code wins for alias under concurrent requests', async () => {
    const targetUrl = 'https://example.com/race-alias';
    const alias = `race-alias-${Math.random().toString(36).slice(2, 8)}`;
    const N = 20;

    const results = await Promise.all(
      Array.from({ length: N }, () => shorten({ url: targetUrl, alias }))
    );

    const codes = results.map((r) => r.statusCode);
    const bodyCodes = results.map((r) => r.json().code);

    expect(codes.filter((c) => c >= 500)).toHaveLength(0);
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 200)).toHaveLength(N - 1);

    const uniqueCodes = [...new Set(bodyCodes)];
    expect(uniqueCodes).toHaveLength(1);
  });
});
