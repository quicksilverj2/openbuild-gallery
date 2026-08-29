import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from './app';
import type { FastifyInstance } from 'fastify';

describe('Shortlink clone', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates a shortlink and redirects', async () => {
    const url = `https://example.com/${Date.now()}`;
    const createRes = await app.inject({
      method: 'POST',
      url: '/shorten',
      payload: { url },
    });
    expect(createRes.statusCode).toBe(201);
    const body = createRes.json();
    expect(body.code).toBeTruthy();
    expect(body.url).toBe(url);
    expect(body.deduped).toBe(false);

    const redirectRes = await app.inject({
      method: 'GET',
      url: `/${body.code}`,
    });
    expect(redirectRes.statusCode).toBe(302);
    expect(redirectRes.headers.location).toBe(url);
  });

  it('dedupes identical URLs', async () => {
    const url = `https://dedupe.example.com/${Date.now()}`;
    const first = await app.inject({
      method: 'POST',
      url: '/shorten',
      payload: { url },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: '/shorten',
      payload: { url },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().code).toBe(first.json().code);
    expect(second.json().deduped).toBe(true);
  });

  it('handles alias conflicts with 409', async () => {
    const alias = `alias-${Date.now()}`;
    await app.inject({
      method: 'POST',
      url: '/shorten',
      payload: { url: 'https://a.example.com', alias },
    });
    const conflict = await app.inject({
      method: 'POST',
      url: '/shorten',
      payload: { url: 'https://b.example.com', alias },
    });
    expect(conflict.statusCode).toBe(409);
  });

  it('returns 404 for unknown codes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/nonexistent-code-xyz',
    });
    expect(res.statusCode).toBe(404);
  });
});
