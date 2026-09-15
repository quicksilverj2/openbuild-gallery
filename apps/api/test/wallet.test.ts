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

function createAccount(id?: string, idempotencyKey?: string) {
  const headers = idempotencyKey ? { 'x-idempotency-key': idempotencyKey } : {};
  return app.inject({
    method: 'POST',
    url: '/accounts',
    payload: id ? { id } : {},
    headers,
  });
}

function deposit(accountId: string, amount: number, idempotencyKey?: string) {
  const headers = idempotencyKey ? { 'x-idempotency-key': idempotencyKey } : {};
  return app.inject({
    method: 'POST',
    url: '/deposits',
    payload: { accountId, amount },
    headers,
  });
}

function transfer(fromAccountId: string, toAccountId: string, amount: number, idempotencyKey?: string) {
  const headers = idempotencyKey ? { 'x-idempotency-key': idempotencyKey } : {};
  return app.inject({
    method: 'POST',
    url: '/transfers',
    payload: { fromAccountId, toAccountId, amount },
    headers,
  });
}

function getAccount(id: string) {
  return app.inject({
    method: 'GET',
    url: `/accounts/${id}`,
  });
}

describe('Wallet — Basic Flow & Validation', () => {
  it('should create a new account with 0 balance', async () => {
    const res = await createAccount();
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeDefined();
    expect(body.balance).toBe(0);
  });

  it('should support creating an account with custom id', async () => {
    const customId = `test-acc-${Math.random().toString(36).slice(2)}`;
    const res = await createAccount(customId);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBe(customId);
    expect(body.balance).toBe(0);
  });

  it('should deposit money into an account and record in ledger', async () => {
    const accRes = await createAccount();
    const acc = accRes.json();

    const depRes = await deposit(acc.id, 1000);
    expect(depRes.statusCode).toBe(201);
    const depBody = depRes.json();
    expect(depBody.balanceAfter).toBe(1000);
    expect(depBody.accountId).toBe(acc.id);
    expect(depBody.amount).toBe(1000);

    const getRes = await getAccount(acc.id);
    const getBody = getRes.json();
    expect(getBody.balance).toBe(1000);
    expect(getBody.ledger).toHaveLength(1);
    expect(getBody.ledger[0].type).toBe('DEPOSIT');
    expect(getBody.ledger[0].amount).toBe(1000);
    expect(getBody.ledger[0].balanceAfter).toBe(1000);
  });

  it('should transfer money atomically and record ledgers for both', async () => {
    const fromRes = await createAccount();
    const toRes = await createAccount();
    const fromAcc = fromRes.json();
    const toAcc = toRes.json();

    await deposit(fromAcc.id, 1000);

    const transRes = await transfer(fromAcc.id, toAcc.id, 400);
    expect(transRes.statusCode).toBe(201);
    const transBody = transRes.json();
    expect(transBody.fromBalanceAfter).toBe(600);
    expect(transBody.toBalanceAfter).toBe(400);

    // Verify fromAccount
    const getFrom = await getAccount(fromAcc.id);
    expect(getFrom.json().balance).toBe(600);
    expect(getFrom.json().ledger).toHaveLength(2); // DEPOSIT and TRANSFER_OUT
    expect(getFrom.json().ledger[0].type).toBe('TRANSFER_OUT');
    expect(getFrom.json().ledger[0].relatedAccountId).toBe(toAcc.id);
    expect(getFrom.json().ledger[0].balanceAfter).toBe(600);

    // Verify toAccount
    const getTo = await getAccount(toAcc.id);
    expect(getTo.json().balance).toBe(400);
    expect(getTo.json().ledger).toHaveLength(1); // TRANSFER_IN
    expect(getTo.json().ledger[0].type).toBe('TRANSFER_IN');
    expect(getTo.json().ledger[0].relatedAccountId).toBe(fromAcc.id);
    expect(getTo.json().ledger[0].balanceAfter).toBe(400);
  });

  it('should reject transfers with non-positive amount or same destination', async () => {
    const acc1 = (await createAccount()).json();
    const acc2 = (await createAccount()).json();

    const r1 = await transfer(acc1.id, acc2.id, -50);
    expect(r1.statusCode).toBe(400);

    const r2 = await transfer(acc1.id, acc1.id, 100);
    expect(r2.statusCode).toBe(400);
  });
});

describe('Wallet — Idempotency Key Gate', () => {
  it('should support idempotent deposits (same key + same body -> exact replay)', async () => {
    const acc = (await createAccount()).json();
    const key = `key-dep-${Math.random().toString(36).slice(2)}`;

    const r1 = await deposit(acc.id, 500, key);
    expect(r1.statusCode).toBe(201);
    const body1 = r1.json();

    const r2 = await deposit(acc.id, 500, key);
    expect(r2.statusCode).toBe(201);
    const body2 = r2.json();

    expect(body1).toEqual(body2);

    // Account should only have 500 paise, not 1000
    const getAcc = await getAccount(acc.id);
    expect(getAcc.json().balance).toBe(500);
    expect(getAcc.json().ledger).toHaveLength(1);
  });

  it('should reject different body with same key (409 conflict)', async () => {
    const acc1 = (await createAccount()).json();
    const acc2 = (await createAccount()).json();
    const key = `key-trans-${Math.random().toString(36).slice(2)}`;

    const r1 = await transfer(acc1.id, acc2.id, 100, key);
    // Might fail with insufficient, let's deposit first
    await deposit(acc1.id, 500);

    const r2 = await transfer(acc1.id, acc2.id, 100, key);
    expect(r2.statusCode).toBe(201);

    const r3 = await transfer(acc1.id, acc2.id, 200, key); // Different body!
    expect(r3.statusCode).toBe(409);
    expect(r3.json().error).toBe('idempotency_key_conflict');
  });
});

describe('Wallet — Hard Concurrency Gate (50 concurrent debits)', () => {
  it('exactly one debit succeeds, balance never goes negative, zero 5xx', async () => {
    const fromAcc = (await createAccount()).json();
    const toAcc = (await createAccount()).json();

    // Start with 100 paise
    await deposit(fromAcc.id, 100);

    // 50 concurrent transfers of 100 paise each from fromAcc to toAcc
    const N = 50;
    const requests = Array.from({ length: N }, (_, i) =>
      transfer(fromAcc.id, toAcc.id, 100, `key-race-${i}-${Math.random().toString(36).slice(2)}`)
    );

    const responses = await Promise.all(requests);
    const statuses = responses.map((r) => r.statusCode);

    const statusCounts = statuses.reduce((acc, status) => {
      acc[status] = (acc[status] ?? 0) + 1;
      return acc;
    }, {} as Record<number, number>);

    console.log(`Race results:`, statusCounts);

    // No 5xx error must ever be thrown
    expect(statuses.some((s) => s >= 500)).toBe(false);

    // Exactly one must succeed (201)
    expect(statusCounts[201]).toBe(1);

    // Remaining must be bad request (400) or other non-200 failure
    expect(statusCounts[400]).toBe(N - 1);

    // Balances must be correct
    const finalFrom = await getAccount(fromAcc.id);
    expect(finalFrom.json().balance).toBe(0);

    const finalTo = await getAccount(toAcc.id);
    expect(finalTo.json().balance).toBe(100);
  });
});
