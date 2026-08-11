import { describe, it, expect, beforeAll } from 'vitest';
import { buildApp } from '../src/app';
import { prisma } from '../src/db';

describe('Wallet Clone', () => {
  const app = buildApp();

  beforeAll(async () => {
    await prisma.transaction.deleteMany();
    await prisma.wallet.deleteMany();
  });

  it('should create a wallet and deposit money', async () => {
    const walletRes = await app.inject({
      method: 'POST',
      url: '/clones/wallet/wallets',
    });
    const { id } = walletRes.json();

    const depositRes = await app.inject({
      method: 'POST',
      url: `/wallets/${id}/deposit`,
      payload: { amount: 1000, idempotencyKey: 'd1' },
    });
    expect(depositRes.statusCode).toBe(201);
    expect(depositRes.json().balance).toBe('1000');

    // Idempotent retry
    const retryRes = await app.inject({
      method: 'POST',
      url: `/wallets/${id}/deposit`,
      payload: { amount: 1000, idempotencyKey: 'd1' },
    });
    expect(retryRes.statusCode).toBe(200);
    expect(retryRes.json().status).toBe('idempotent_replay');
  });

  it('should transfer money between wallets', async () => {
    const w1 = (await app.inject({ method: 'POST', url: '/clones/wallet/wallets' })).json();
    const w2 = (await app.inject({ method: 'POST', url: '/clones/wallet/wallets' })).json();

    await app.inject({
      method: 'POST',
      url: `/wallets/${w1.id}/deposit`,
      payload: { amount: 5000, idempotencyKey: 'w1d' },
    });

    const transferRes = await app.inject({
      method: 'POST',
      url: `/wallets/${w1.id}/transfer`,
      payload: { toWalletId: w2.id, amount: 2000, idempotencyKey: 't1' },
    });
    expect(transferRes.statusCode).toBe(201);

    const check1 = (await app.inject({ method: 'GET', url: `/wallets/${w1.id}` })).json();
    const check2 = (await app.inject({ method: 'GET', url: `/wallets/${w2.id}` })).json();

    expect(check1.balance).toBe('3000');
    expect(check2.balance).toBe('2000');
  });

  it('should handle concurrent transfers and prevent overdraft', async () => {
    const w1 = (await app.inject({ method: 'POST', url: '/clones/wallet/wallets' })).json();
    const w2 = (await app.inject({ method: 'POST', url: '/clones/wallet/wallets' })).json();

    await app.inject({
      method: 'POST',
      url: `/wallets/${w1.id}/deposit`,
      payload: { amount: 1000, idempotencyKey: 'w1d2' },
    });

    // 20 concurrent transfers of 1000 each. Only one should succeed.
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        app.inject({
          method: 'POST',
          url: `/wallets/${w1.id}/transfer`,
          payload: { toWalletId: w2.id, amount: 1000, idempotencyKey: `ct-${i}` },
        }),
      ),
    );

    const statuses = results.map((r) => r.statusCode);
    const count201 = statuses.filter((s) => s === 201).length;
    const count400 = statuses.filter((s) => s === 400).length;

    expect(count201).toBe(1);
    expect(count400).toBe(19);

    const finalW1 = (await app.inject({ method: 'GET', url: `/wallets/${w1.id}` })).json();
    expect(finalW1.balance).toBe('0');
  });
});
