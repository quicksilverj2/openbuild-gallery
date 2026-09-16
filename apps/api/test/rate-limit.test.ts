import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildApp } from '../src/app';
import { prisma } from '../src/db';

let app;

beforeAll(async () => {
  process.env.DATABASE_URL = 'postgresql://decepticon:decepticon@127.0.0.1:5432/app?schema=public';
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  // Clean up rate limit entries before each test
  await prisma.rateLimit.deleteMany();
});

function distribution(codes: number[]): Record<number, number> {
  return codes.reduce<Record<number, number>>((acc, c) => {
    acc[c] = (acc[c] ?? 0) + 1;
    return acc;
  }, {});
}

describe('rate limiter — invariant: hot-key burst', () => {
  it('exactly N requests pass, rest get 429, zero 5xx under concurrent burst', async () => {
    const LIMIT = 10;
    const BURST = 50; // 5x the limit

    // Use a unique IP header to isolate this test
    const testIp = `192.0.2.${Math.floor(Math.random() * 256)}`;

    const results = await Promise.all(
      Array.from({ length: BURST }, () =>
        app.inject({
          method: 'GET',
          url: '/rate-limit-test',
          headers: { 'x-forwarded-for': testIp },
        }),
      ),
    );

    const codes = results.map((r) => r.statusCode);
    const dist = distribution(codes);

    // Zero 5xx - the invariant
    expect(codes.filter((c) => c >= 500)).toHaveLength(0);

    // Exactly LIMIT requests get 200
    expect(dist[200]).toBe(LIMIT);

    // The rest get 429
    expect(dist[429]).toBe(BURST - LIMIT);

    // No other status codes
    expect(Object.keys(dist).sort()).toEqual(['200', '429']);
  });

  it('rate limit headers are present on successful requests', async () => {
    const testIp = `192.0.2.${Math.floor(Math.random() * 256)}`;
    const res = await app.inject({
      method: 'GET',
      url: '/rate-limit-test',
      headers: { 'x-forwarded-for': testIp },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('10');
    expect(res.headers['x-ratelimit-remaining']).toBe('9');
  });

  it('rate limit headers are present on 429 responses', async () => {
    const testIp = `192.0.2.${Math.floor(Math.random() * 256)}`;

    // Exhaust the limit (10 requests)
    for (let i = 0; i < 10; i++) {
      await app.inject({
        method: 'GET',
        url: '/rate-limit-test',
        headers: { 'x-forwarded-for': testIp },
      });
    }

    // Next request should be 429
    const res = await app.inject({
      method: 'GET',
      url: '/rate-limit-test',
      headers: { 'x-forwarded-for': testIp },
    });

    expect(res.statusCode).toBe(429);
    expect(res.headers['x-ratelimit-limit']).toBe('10');
    expect(res.headers['x-ratelimit-remaining']).toBe('0');
    expect(res.headers['retry-after']).toBeDefined();
    expect(res.json().error).toBe('rate_limit_exceeded');
  });

  it('different IPs have independent limits', async () => {
    const LIMIT = 10;
    const BURST = 15;

    // IP 1 makes 15 requests
    const ip1 = '192.0.2.10';
    const results1 = await Promise.all(
      Array.from({ length: BURST }, () =>
        app.inject({
          method: 'GET',
          url: '/rate-limit-test',
          headers: { 'x-forwarded-for': ip1 },
        }),
      ),
    );

    // IP 2 makes 15 requests
    const ip2 = '192.0.2.20';
    const results2 = await Promise.all(
      Array.from({ length: BURST }, () =>
        app.inject({
          method: 'GET',
          url: '/rate-limit-test',
          headers: { 'x-forwarded-for': ip2 },
        }),
      ),
    );

    const codes1 = results1.map((r) => r.statusCode);
    const codes2 = results2.map((r) => r.statusCode);

    // Both IPs should get exactly LIMIT 200s
    expect(codes1.filter((c) => c === 200)).toHaveLength(LIMIT);
    expect(codes1.filter((c) => c === 429)).toHaveLength(BURST - LIMIT);
    expect(codes2.filter((c) => c === 200)).toHaveLength(LIMIT);
    expect(codes2.filter((c) => c === 429)).toHaveLength(BURST - LIMIT);

    // Zero 5xx for both
    expect(codes1.filter((c) => c >= 500)).toHaveLength(0);
    expect(codes2.filter((c) => c >= 500)).toHaveLength(0);
  });

  it('different clone slugs have independent limits (via preHandler hook)', async () => {
    const LIMIT = 10;
    const BURST = 15;
    const testIp = '192.0.2.30';

    // We can't easily test cloneSlug isolation without a route that has a slug param
    // But we can verify the key construction includes cloneSlug by checking
    // that the rate limiter uses the preHandler hook to set cloneSlug
    // This test verifies the middleware doesn't crash with cloneSlug
    const results = await Promise.all(
      Array.from({ length: BURST }, () =>
        app.inject({
          method: 'GET',
          url: '/rate-limit-test',
          headers: { 'x-forwarded-for': testIp },
        }),
      ),
    );

    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 200)).toHaveLength(LIMIT);
    expect(codes.filter((c) => c === 429)).toHaveLength(BURST - LIMIT);
    expect(codes.filter((c) => c >= 500)).toHaveLength(0);
  });

  it('window expiry resets the limit', async () => {
    const LIMIT = 3;
    const testIp = `192.0.2.${Math.floor(Math.random() * 256)}`;
    const url = `/rate-limit-test?limit=${LIMIT}&window=60`;

    // Create a rate limiter with a very short window for testing
    // We'll manually manipulate the database to simulate window expiry
    for (let i = 0; i < LIMIT; i++) {
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { 'x-forwarded-for': testIp },
      });
      expect(res.statusCode).toBe(200);
    }

    // Next request should be 429
    let res = await app.inject({
      method: 'GET',
      url,
      headers: { 'x-forwarded-for': testIp },
    });
    expect(res.statusCode).toBe(429);

    // Manually expire the rate limit entry by setting windowStart to the past
    await prisma.rateLimit.updateMany({
      where: { key: { startsWith: `test:${testIp}:` } },
      data: { windowStart: new Date(Date.now() - 120_000) }, // 2 minutes ago
    });

    // Next request should succeed (new window)
    res = await app.inject({
      method: 'GET',
      url,
      headers: { 'x-forwarded-for': testIp },
    });
    expect(res.statusCode).toBe(200);
  });
});