import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { prisma } from '../src/db';

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
  await prisma.clone.upsert({
    where: { slug: 'wallet' },
    update: {},
    create: { slug: 'wallet', title: 'Wallet', summary: 'test', demoPath: '/clones/wallet' },
  });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function createWallet(ownerId: string, initialPaise = 0): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/clones/wallet/wallets',
    payload: { ownerId, initialPaise },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

function transfer(fromId: string, toId: string, amountPaise: number, idempotencyKey: string) {
  return app.inject({
    method: 'POST',
    url: '/clones/wallet/transfers',
    payload: { fromWalletId: fromId, toWalletId: toId, amountPaise, idempotencyKey },
  });
}

function distribution(codes: number[]): Record<number, number> {
  return codes.reduce<Record<number, number>>((acc, c) => {
    acc[c] = (acc[c] ?? 0) + 1;
    return acc;
  }, {});
}

describe('wallet â€” happy path', () => {
  it('creates wallets and transfers between them', async () => {
    const a = await createWallet('alice', 10000);
    const b = await createWallet('bob', 0);
    const res = await transfer(a, b, 5000, 'tx-1');
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('transferred');

    const alice = await app.inject({ method: 'GET', url: `/wallets/${a}` });
    expect(alice.json().balancePaise).toBe('5000');
    const bob = await app.inject({ method: 'GET', url: `/wallets/${b}` });
    expect(bob.json().balancePaise).toBe('5000');
  });

  it('idempotent retry with same key + same body returns 200', async () => {
    const a = await createWallet('idemp-a', 10000);
    const b = await createWallet('idemp-b', 0);
    const first = await transfer(a, b, 3000, 'idemp-tx-1');
    expect(first.statusCode).toBe(201);
    const second = await transfer(a, b, 3000, 'idemp-tx-1');
    expect(second.statusCode).toBe(200);
    expect(second.json().status).toBe('duplicate_ignored');

    const alice = await app.inject({ method: 'GET', url: `/wallets/${a}` });
    expect(alice.json().balancePaise).toBe('7000');
  });
});

describe('invariant: 50 concurrent full-balance debits -> exactly one wins, zero 5xx', () => {
  it('50 concurrent transfers of full balance -> 1 success, 49 rejected, zero 5xx', async () => {
    const a = await createWallet('race-alice', 5000);
    const b = await createWallet('race-bob', 0);
    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => transfer(a, b, 5000, `race-tx-${i}`)),
    );
    const codes = results.map((r) => r.statusCode);
    const dist = distribution(codes);

    expect(codes.filter((c) => c >= 500)).toHaveLength(0);
    expect(dist[201]).toBe(1);
    expect(dist[409]).toBe(N - 1);

    const alice = await app.inject({ method: 'GET', url: `/wallets/${a}` });
    expect(alice.json().balancePaise).toBe('0');
    const bob = await app.inject({ method: 'GET', url: `/wallets/${b}` });
    expect(bob.json().balancePaise).toBe('5000');
  });
});

describe('wallet â€” error handling', () => {
  it('same idempotency key + different body -> 409', async () => {
    const a = await createWallet('conflict-a', 10000);
    const b = await createWallet('conflict-b', 0);
    const c = await createWallet('conflict-c', 0);
    await transfer(a, b, 1000, 'conflict-key');
    const res = await transfer(a, c, 2000, 'conflict-key');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('idempotency_key_conflict');
  });

  it('transfer more than balance -> 409', async () => {
    const a = await createWallet('poor-a', 100);
    const b = await createWallet('poor-b', 0);
    const res = await transfer(a, b, 500, 'overdraft-tx');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('insufficient_balance');
  });

  it('404 for non-existent wallet', async () => {
    const res = await app.inject({ method: 'GET', url: '/wallets/nonexistent' });
    expect(res.statusCode).toBe(404);
  });

  it('rejects negative amount with 400', async () => {
    const a = await createWallet('neg-a', 1000);
    const b = await createWallet('neg-b', 0);
    const res = await transfer(a, b, -100, 'neg-tx');
    expect(res.statusCode).toBe(400);
  });

  it('rejects zero amount with 400', async () => {
    const a = await createWallet('zero-a', 1000);
    const b = await createWallet('zero-b', 0);
    const res = await transfer(a, b, 0, 'zero-tx');
    expect(res.statusCode).toBe(400);
  });

  it('rejects transfer to self with 400', async () => {
    const a = await createWallet('self-a', 1000);
    const res = await transfer(a, a, 100, 'self-tx');
    expect(res.statusCode).toBe(400);
  });
});
