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
    create: { slug: 'wallet', title: 'Wallet', summary: 'wal', demoPath: '/clones/wallet' },
  });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function newWallet(ownerId: string, initialBalance: number): Promise<{ id: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/clones/wallet/wallets',
    payload: { ownerId, initialBalance },
  });
  expect([201, 409]).toContain(res.statusCode);
  if (res.statusCode === 201) return res.json();
  const w = await prisma.wallet.findUnique({ where: { cloneSlug_ownerId: { cloneSlug: 'wallet', ownerId } } });
  return { id: w!.id };
}

function transfer(fromId: string, payload: any) {
  return app.inject({ method: 'POST', url: /wallets/ + fromId + /transfers, payload });
}

describe('wallet clone invariant', () => {
  it('concurrent transfers exceeding balance fail cleanly without oversell, zero 5xx', async () => {
    const { id: fromId } = await newWallet('alice', 10);
    const { id: toId } = await newWallet('bob', 0);
    
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => transfer(fromId, {
        toId,
        idempotencyKey: k- + i,
        amount: 2 // 10 / 2 = 5 should succeed
      }))
    );
    
    const codes = results.map((r) => r.statusCode);
    
    expect(codes.filter((c) => c >= 500)).toHaveLength(0); // zero 5xx
    expect(codes.filter((c) => c === 201)).toHaveLength(5); // exactly 5 winners (5 * 2 = 10)
    expect(codes.filter((c) => c === 409)).toHaveLength(15); // exactly 15 cleanly rejected
  });
});
