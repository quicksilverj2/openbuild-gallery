import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { prisma } from '../src/db';

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
  await prisma.clone.upsert({
    where: { slug: 'poll' },
    update: {},
    create: { slug: 'poll', title: 'Poll', summary: 'test', demoPath: '/clones/poll' },
  });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('/metrics endpoint', () => {
  it('should include http_requests_total with per-clone labels', async () => {
    // Make a request to the poll clone
    await app.inject({
      method: 'POST',
      url: '/clones/poll/polls',
      payload: { question: 'Metrics test?', options: ['A', 'B'] },
    });

    const res = await app.inject({ method: 'GET', url: '/metrics' });
    const text = res.body;
    expect(res.statusCode).toBe(200);
    expect(text).toContain('openbuild_http_requests_total{clone="poll",method="POST",status="201"}');
  });
});
