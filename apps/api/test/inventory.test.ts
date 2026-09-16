import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { prisma } from '../src/db';

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

beforeEach(async () => {
  await prisma.reservation.deleteMany();
  await prisma.inventoryItem.deleteMany();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

function createInventory(payload: Record<string, any>) {
  return app.inject({ method: 'POST', url: '/inventory', payload });
}

function getInventory(id: string) {
  return app.inject({ method: 'GET', url: `/inventory/${id}` });
}

function reserve(id: string, payload: Record<string, any>) {
  return app.inject({ method: 'POST', url: `/inventory/${id}/reserve`, payload });
}

function release(id: string, payload: Record<string, any>) {
  return app.inject({ method: 'POST', url: `/inventory/${id}/release`, payload });
}

describe('inventory — happy path', () => {
  it('creates an inventory item', async () => {
    const res = await createInventory({ sku: 'SKU-001', name: 'Test Item', totalQty: 100 });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeDefined();
    expect(body.sku).toBe('SKU-001');
    expect(body.name).toBe('Test Item');
    expect(body.totalQty).toBe(100);
    expect(body.availableQty).toBe(100);
  });

  it('gets an inventory item', async () => {
    const createRes = await createInventory({ sku: 'SKU-002', name: 'Test Item 2', totalQty: 50 });
    const item = createRes.json();

    const getRes = await getInventory(item.id);
    expect(getRes.statusCode).toBe(200);
    const body = getRes.json();
    expect(body.id).toBe(item.id);
    expect(body.sku).toBe('SKU-002');
    expect(body.totalQty).toBe(50);
    expect(body.reservedQty).toBe(0);
    expect(body.availableQty).toBe(50);
  });

  it('reserves quantity successfully', async () => {
    const createRes = await createInventory({ sku: 'SKU-003', name: 'Test Item 3', totalQty: 100 });
    const item = createRes.json();

    const reserveRes = await reserve(item.id, { qty: 10, idempotencyKey: 'key-1' });
    expect(reserveRes.statusCode).toBe(201);
    const body = reserveRes.json();
    expect(body.reservationId).toBeDefined();
    expect(body.qty).toBe(10);

    // Verify available quantity decreased
    const getRes = await getInventory(item.id);
    expect(getRes.json().availableQty).toBe(90);
    expect(getRes.json().reservedQty).toBe(10);
  });

  it('releases a reservation', async () => {
    const createRes = await createInventory({ sku: 'SKU-004', name: 'Test Item 4', totalQty: 100 });
    const item = createRes.json();

    const reserveRes = await reserve(item.id, { qty: 20, idempotencyKey: 'key-release-1' });
    const reservation = reserveRes.json();

    const releaseRes = await release(item.id, { idempotencyKey: 'key-release-1' });
    expect(releaseRes.statusCode).toBe(200);
    expect(releaseRes.json().status).toBe('released');
    expect(releaseRes.json().qty).toBe(20);

    // Verify available quantity restored
    const getRes = await getInventory(item.id);
    expect(getRes.json().availableQty).toBe(100);
    expect(getRes.json().reservedQty).toBe(0);
  });
});

describe('inventory — idempotency', () => {
  it('idempotent reserve replay returns 200 with existing reservation', async () => {
    const createRes = await createInventory({ sku: 'SKU-005', name: 'Test Item 5', totalQty: 100 });
    const item = createRes.json();

    const key = 'idem-key-1';
    const res1 = await reserve(item.id, { qty: 5, idempotencyKey: key });
    expect(res1.statusCode).toBe(201);
    const body1 = res1.json();

    const res2 = await reserve(item.id, { qty: 5, idempotencyKey: key });
    expect(res2.statusCode).toBe(200);
    expect(res2.json().status).toBe('duplicate_ignored');
    expect(res2.json().reservationId).toBe(body1.reservationId);
    expect(res2.json().qty).toBe(5);

    // Available qty should only be decremented once
    const getRes = await getInventory(item.id);
    expect(getRes.json().availableQty).toBe(95);
  });

  it('rejects different qty with same idempotency key (409)', async () => {
    const createRes = await createInventory({ sku: 'SKU-006', name: 'Test Item 6', totalQty: 100 });
    const item = createRes.json();

    const key = 'idem-key-conflict';
    await reserve(item.id, { qty: 5, idempotencyKey: key });
    const res2 = await reserve(item.id, { qty: 10, idempotencyKey: key });
    expect(res2.statusCode).toBe(409);
    expect(res2.json().error).toBe('idempotency_key_conflict');
  });

  it('idempotent release replay returns 200', async () => {
    const createRes = await createInventory({ sku: 'SKU-007', name: 'Test Item 7', totalQty: 100 });
    const item = createRes.json();

    const key = 'idem-release-key';
    await reserve(item.id, { qty: 15, idempotencyKey: key });
    await release(item.id, { idempotencyKey: key });

    const res2 = await release(item.id, { idempotencyKey: key });
    expect(res2.statusCode).toBe(200);
    expect(res2.json().status).toBe('already_released');
  });
});

describe('inventory — validation and errors', () => {
  it('returns 400 for invalid SKU', async () => {
    const res = await createInventory({ sku: '', name: 'Test', totalQty: 10 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('returns 400 for negative totalQty', async () => {
    const res = await createInventory({ sku: 'SKU-TEST', name: 'Test', totalQty: -5 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('returns 409 for duplicate SKU', async () => {
    await createInventory({ sku: 'SKU-DUP', name: 'Test', totalQty: 10 });
    const res = await createInventory({ sku: 'SKU-DUP', name: 'Test 2', totalQty: 20 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('sku_already_exists');
  });

  it('returns 404 for non-existent item', async () => {
    const res = await getInventory('non-existent-id');
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('item_not_found');
  });

  it('returns 404 for reserve on non-existent item', async () => {
    const res = await reserve('non-existent-id', { qty: 1, idempotencyKey: 'key' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('item_not_found');
  });

  it('returns 409 for insufficient stock', async () => {
    const createRes = await createInventory({ sku: 'SKU-008', name: 'Test Item 8', totalQty: 10 });
    const item = createRes.json();

    await reserve(item.id, { qty: 10, idempotencyKey: 'key-full' });
    const res = await reserve(item.id, { qty: 1, idempotencyKey: 'key-over' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('insufficient_stock');
    expect(res.json().availableQty).toBe(0);
  });

  it('returns 404 for release of non-existent reservation', async () => {
    const createRes = await createInventory({ sku: 'SKU-009', name: 'Test Item 9', totalQty: 10 });
    const item = createRes.json();

    const res = await release(item.id, { idempotencyKey: 'non-existent-key' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('reservation_not_found');
  });
});

describe('invariant: concurrent reservations of last units', () => {
  it('exactly `available` succeed, rest cleanly rejected, zero 5xx', async () => {
    const createRes = await createInventory({ sku: 'SKU-RACE', name: 'Race Item', totalQty: 10 });
    const item = createRes.json();

    // Try to reserve 1 unit each, 20 concurrent requests for 10 available
    const N = 20;
    const qtyPerRequest = 1;

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        reserve(item.id, { qty: qtyPerRequest, idempotencyKey: `race-key-${i}` })
      )
    );

    const codes = results.map((r) => r.statusCode);

    // No server errors
    const serverErrors = codes.filter((c) => c >= 500);
    expect(serverErrors).toHaveLength(0);

    // Exactly 10 succeed (201), 10 fail with 409 (insufficient_stock)
    const success = codes.filter((c) => c === 201);
    const insufficient = codes.filter((c) => c === 409);

    expect(success).toHaveLength(10);
    expect(insufficient).toHaveLength(10);

    // Verify final state: all 10 units reserved
    const getRes = await getInventory(item.id);
    expect(getRes.json().availableQty).toBe(0);
    expect(getRes.json().reservedQty).toBe(10);
  });

  it('concurrent reservations with varying quantities - total never exceeds available', async () => {
    const createRes = await createInventory({ sku: 'SKU-RACE2', name: 'Race Item 2', totalQty: 100 });
    const item = createRes.json();

    // 20 concurrent requests, each trying to reserve 10 units (total 200 requested, only 100 available)
    const N = 20;
    const qtyPerRequest = 10;

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        reserve(item.id, { qty: qtyPerRequest, idempotencyKey: `race2-key-${i}` })
      )
    );

    const codes = results.map((r) => r.statusCode);

    // No server errors
    expect(codes.filter((c) => c >= 500)).toHaveLength(0);

    // Exactly 10 succeed (10 * 10 = 100), 10 fail
    const success = codes.filter((c) => c === 201);
    expect(success).toHaveLength(10);

    // Verify final state
    const getRes = await getInventory(item.id);
    expect(getRes.json().availableQty).toBe(0);
    expect(getRes.json().reservedQty).toBe(100);
  });
});