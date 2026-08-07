import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { prisma } from '../src/db';

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
  await prisma.clone.upsert({
    where: { slug: 'inventory' },
    update: {},
    create: { slug: 'inventory', title: 'Inventory', summary: 'test', demoPath: '/clones/inventory' },
  });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function createItem(name: string, totalUnits: number): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/clones/inventory/items',
    payload: { name, totalUnits },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

function reserve(itemId: string, userId: string, units: number, key: string) {
  return app.inject({
    method: 'POST',
    url: `/items/${itemId}/reserve`,
    payload: { userId, units, idempotencyKey: key },
  });
}

function distribution(codes: number[]): Record<number, number> {
  return codes.reduce<Record<number, number>>((acc, c) => {
    acc[c] = (acc[c] ?? 0) + 1;
    return acc;
  }, {});
}

describe('inventory â€” happy path', () => {
  it('creates an item and reserves units', async () => {
    const id = await createItem('Tickets', 100);
    const res = await reserve(id, 'user-A', 5, 'r1');
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('reserved');
  });

  it('idempotent retry returns 200', async () => {
    const id = await createItem('T-shirts', 50);
    const first = await reserve(id, 'user-B', 3, 'idem-1');
    expect(first.statusCode).toBe(201);
    const second = await reserve(id, 'user-B', 3, 'idem-1');
    expect(second.statusCode).toBe(200);
    expect(second.json().status).toBe('duplicate_ignored');
  });
});

describe('invariant: concurrent reservations never oversell, zero 5xx', () => {
  it('50 concurrent reservations of 1 unit from a 5-unit item -> exactly 5 succeed', async () => {
    const id = await createItem('Limited', 5);
    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => reserve(id, `user-${i}`, 1, `key-${i}`)),
    );
    const codes = results.map((r) => r.statusCode);
    const dist = distribution(codes);

    expect(codes.filter((c) => c >= 500)).toHaveLength(0);
    expect(dist[201]).toBe(5);
    expect(dist[409]).toBe(N - 5);
  });

  it('50 concurrent reservations of full 10 units from a 10-unit item -> exactly 1 succeeds', async () => {
    const id = await createItem('OneShot', 10);
    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => reserve(id, `user-${i}`, 10, `full-${i}`)),
    );
    const codes = results.map((r) => r.statusCode);
    const dist = distribution(codes);

    expect(codes.filter((c) => c >= 500)).toHaveLength(0);
    expect(dist[201]).toBe(1);
    expect(dist[409]).toBe(N - 1);
  });
});

describe('inventory â€” release', () => {
  it('releasing a reservation frees units', async () => {
    const id = await createItem('Returnable', 10);
    const res = await reserve(id, 'user-C', 3, 'rel-1');
    expect(res.statusCode).toBe(201);

    const releaseRes = await app.inject({ method: 'POST', url: `/reservations/${res.json().reservationId}/release` });
    expect(releaseRes.statusCode).toBe(200);
    expect(releaseRes.json().status).toBe('released');

    const item = await app.inject({ method: 'GET', url: `/items/${id}` });
    expect(item.json().reservedUnits).toBe(0);
    expect(item.json().available).toBe(10);
  });

  it('double release is idempotent', async () => {
    const id = await createItem('DoubleRel', 10);
    const res = await reserve(id, 'user-D', 2, 'rel-2');
    const resId = res.json().reservationId;

    await app.inject({ method: 'POST', url: `/reservations/${resId}/release` });
    const second = await app.inject({ method: 'POST', url: `/reservations/${resId}/release` });
    expect(second.statusCode).toBe(200);
    expect(second.json().status).toBe('already_released');
  });
});

describe('inventory â€” error handling', () => {
  it('404 for non-existent item', async () => {
    const res = await reserve('nonexistent', 'user', 1, 'key');
    expect(res.statusCode).toBe(404);
  });

  it('rejects zero units with 400', async () => {
    const id = await createItem('Zero', 10);
    const res = await reserve(id, 'user', 0, 'zero-key');
    expect(res.statusCode).toBe(400);
  });

  it('same key + different body -> 409', async () => {
    const id = await createItem('Conflict', 100);
    await reserve(id, 'user-E', 5, 'conflict-key');
    const res = await reserve(id, 'user-F', 3, 'conflict-key');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('idempotency_key_conflict');
  });
});
