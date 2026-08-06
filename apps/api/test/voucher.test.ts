import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { prisma } from '../src/db';

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
  await prisma.clone.upsert({
    where: { slug: 'voucher' },
    update: {},
    create: { slug: 'voucher', title: 'Voucher', summary: 'test', demoPath: '/clones/voucher' },
  });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

function createVoucher(payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/voucher', payload });
}

function redeemVoucher(code: string, payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: `/voucher/${code}/redeem`, payload });
}

function distribution(codes: number[]): Record<number, number> {
  return codes.reduce<Record<number, number>>((acc, c) => {
    acc[c] = (acc[c] ?? 0) + 1;
    return acc;
  }, {});
}

const RUN = `${Date.now().toString(36)}`;

describe('voucher — happy path', () => {
  it('creates and redeems a voucher', async () => {
    const create = await createVoucher({ code: `HAPPY-${RUN}`, value: 'free coffee' });
    expect(create.statusCode).toBe(201);
    expect(create.json().code).toBe(`HAPPY-${RUN}`);
    expect(create.json().value).toBe('free coffee');
    expect(create.json().redeemedBy).toBeNull();

    const redeem = await redeemVoucher(`HAPPY-${RUN}`, { userId: 'alice' });
    expect(redeem.statusCode).toBe(200);
    expect(redeem.json().redeemedBy).toBe('alice');
    expect(redeem.json().redeemedAt).toBeTruthy();
  });

  it('returns 409 when already redeemed', async () => {
    const code = `REDEEMED-${RUN}`;
    await createVoucher({ code, value: '10% OFF' });

    // First redeem succeeds
    const first = await redeemVoucher(code, { userId: 'alice' });
    expect(first.statusCode).toBe(200);

    // Second redeem fails with 409
    const second = await redeemVoucher(code, { userId: 'bob' });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('already_redeemed');
  });

  it('returns 404 for unknown voucher', async () => {
    const res = await redeemVoucher(`NO-SUCH-${RUN}`, { userId: 'alice' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('voucher_not_found');
  });

  it('returns 400 for missing fields', async () => {
    const res = await app.inject({ method: 'POST', url: '/voucher', payload: {} });
    expect(res.statusCode).toBe(400);
  });
});

describe('invariant: concurrent redeems of one voucher', () => {
  it('20 concurrent redeems → exactly one succeeds, rest 409, zero 5xx', async () => {
    const code = `CONC-${RUN}`;
    const create = await createVoucher({ code, value: 'concurrency test' });
    expect(create.statusCode).toBe(201);

    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => redeemVoucher(code, { userId: `user-${i}` })),
    );
    const codes = results.map((r) => r.statusCode);
    const dist = distribution(codes);

    // zero 5xx
    expect(codes.filter((c) => c >= 500)).toHaveLength(0);

    // exactly one redeem succeeds (200)
    expect(dist[200] ?? 0).toBe(1);

    // the rest get 409
    expect(dist[409] ?? 0).toBe(N - 1);
  });
});
