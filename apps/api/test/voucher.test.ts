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

async function createVoucher(code?: string): Promise<string> {
  const c = code ?? `voucher-${Math.random().toString(36).slice(2)}`;
  const res = await app.inject({
    method: 'POST',
    url: '/clones/voucher/vouchers',
    payload: { code: c },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

function redeem(voucherId: string, userId: string) {
  return app.inject({
    method: 'POST',
    url: `/vouchers/${voucherId}/redeem`,
    payload: { userId },
  });
}

function distribution(codes: number[]): Record<number, number> {
  return codes.reduce<Record<number, number>>((acc, c) => {
    acc[c] = (acc[c] ?? 0) + 1;
    return acc;
  }, {});
}

describe('voucher â€” happy path', () => {
  it('creates and redeems a voucher', async () => {
    const id = await createVoucher();
    const res = await redeem(id, 'user-A');
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('redeemed');
  });

  it('same user redeeming twice is idempotent (200)', async () => {
    const id = await createVoucher();
    const first = await redeem(id, 'user-B');
    expect(first.statusCode).toBe(201);
    const second = await redeem(id, 'user-B');
    expect(second.statusCode).toBe(200);
    expect(second.json().status).toBe('duplicate_ignored');
  });

  it('different user after redemption gets 409', async () => {
    const id = await createVoucher();
    await redeem(id, 'user-first');
    const res = await redeem(id, 'user-second');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('voucher_taken');
  });
});

describe('invariant: concurrent redeems of one voucher -> exactly one wins, zero 5xx', () => {
  it('50 concurrent redeems from the SAME user -> 1 win, 49 idempotent, zero 5xx', async () => {
    const id = await createVoucher();
    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, () => redeem(id, 'same-user')),
    );
    const codes = results.map((r) => r.statusCode);
    const dist = distribution(codes);

    expect(codes.filter((c) => c >= 500)).toHaveLength(0);
    expect(dist[201]).toBe(1);
    expect(dist[200]).toBe(N - 1);
  });

  it('50 concurrent redeems from DIFFERENT users -> 1 win, 49 get 409, zero 5xx', async () => {
    const id = await createVoucher();
    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => redeem(id, `user-${i}`)),
    );
    const codes = results.map((r) => r.statusCode);
    const dist = distribution(codes);

    expect(codes.filter((c) => c >= 500)).toHaveLength(0);
    expect(dist[201]).toBe(1);
    expect(dist[409]).toBe(N - 1);
  });
});

describe('voucher â€” error handling', () => {
  it('404 for non-existent voucher', async () => {
    const res = await redeem('nonexistent-id', 'user-X');
    expect(res.statusCode).toBe(404);
  });

  it('rejects empty code with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/clones/voucher/vouchers',
      payload: { code: '' },
    });
    expect(res.statusCode).toBe(400);
  });
});
