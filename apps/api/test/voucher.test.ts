import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../src/app';
import { prisma } from '../src/db';

describe('Voucher Clone', () => {
  const app = buildApp();
  const slug = 'voucher-test';

  beforeAll(async () => {
    await prisma.clone.upsert({
      where: { slug },
      create: { slug, title: 'Voucher Test', summary: 'Testing vouchers', demoPath: '/vouchers' },
      update: {},
    });
  });

  it('should redeem a voucher exactly once', async () => {
    const code = `VOUCH-${Math.random().toString(36).slice(2, 7)}`;
    
    // Create voucher
    await app.inject({
      method: 'POST',
      url: `/clones/${slug}/vouchers`,
      payload: { code },
    });

    // Concurrent redeems
    const redeems = Array.from({ length: 5 }).map((_, i) =>
      app.inject({
        method: 'POST',
        url: '/vouchers/redeem',
        payload: {
          code,
          userId: `user-${i}`,
          idempotencyKey: `key-${i}`,
        },
      })
    );

    const results = await Promise.all(redeems);
    const statuses = results.map((r) => r.statusCode);

    // One should succeed, others should fail with 409
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(4);
  });

  it('should be idempotent for the same user and key', async () => {
    const code = `VOUCH-${Math.random().toString(36).slice(2, 7)}`;
    const userId = 'user-1';
    const idempotencyKey = 'key-1';

    // Create voucher
    await app.inject({
      method: 'POST',
      url: `/clones/${slug}/vouchers`,
      payload: { code },
    });

    // First redeem
    const res1 = await app.inject({
      method: 'POST',
      url: '/vouchers/redeem',
      payload: { code, userId, idempotencyKey },
    });
    expect(res1.statusCode).toBe(201);

    // Second redeem (same key)
    const res2 = await app.inject({
      method: 'POST',
      url: '/vouchers/redeem',
      payload: { code, userId, idempotencyKey },
    });
    expect(res2.statusCode).toBe(200);
    expect(JSON.parse(res2.payload).id).toBe(JSON.parse(res1.payload).id);
  });
});
