import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { prisma } from '../src/db';
import { resetMetrics } from '../src/observability';

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

describe('Observability Plugin & Invariants', () => {
  it('propagates custom x-request-id or generates one', async () => {
    // Caso 1: Header provisto por el cliente
    const resWithHeader = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-request-id': 'custom-trace-uuid-1234' },
    });
    expect(resWithHeader.statusCode).toBe(200);
    expect(resWithHeader.headers['x-request-id']).toBe('custom-trace-uuid-1234');

    // Caso 2: Sin header, debe generar uno
    const resWithoutHeader = await app.inject({
      method: 'GET',
      url: '/healthz',
    });
    expect(resWithoutHeader.statusCode).toBe(200);
    expect(resWithoutHeader.headers['x-request-id']).toBeDefined();
    expect(typeof resWithoutHeader.headers['x-request-id']).toBe('string');
  });

  it('exposes Prometheus metrics per clone, method, and status', async () => {
    resetMetrics();

    // 1 request a core (/healthz)
    await app.inject({ method: 'GET', url: '/healthz' });

    // 1 request a clone poll (/clones/poll/polls)
    await app.inject({
      method: 'POST',
      url: '/clones/poll/polls',
      payload: { question: 'Metric test?', options: ['Yes', 'No'] },
    });

    const metricsRes = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metricsRes.statusCode).toBe(200);
    expect(metricsRes.headers['content-type']).toContain('text/plain');

    const body = metricsRes.body;
    expect(body).toContain('# TYPE openbuild_http_requests_total counter');
    expect(body).toContain(
      'openbuild_http_requests_total{clone="core",method="GET",status="200"} 1',
    );
    expect(body).toContain(
      'openbuild_http_requests_total{clone="poll",method="POST",status="201"} 1',
    );
  });

  it('preserves invariants and produces zero 5xx under concurrent bursts', async () => {
    // Creamos una encuesta
    const pollRes = await app.inject({
      method: 'POST',
      url: '/clones/poll/polls',
      payload: { question: 'Concurrency probe?', options: ['Option 1', 'Option 2'] },
    });
    const { id: pollId, options } = pollRes.json();
    const optionId = options[0].id;

    // Ráfaga concurrente: mismo votante intentando votar 20 veces a la vez
    const requests = Array.from({ length: 20 }, (_, i) =>
      app.inject({
        method: 'POST',
        url: `/polls/${pollId}/votes`,
        headers: { 'x-request-id': `burst-test-${i}` },
        payload: {
          optionId,
          voterId: 'voter-concurrent-test',
          idempotencyKey: `key-${i}`,
        },
      }),
    );

    const responses = await Promise.all(requests);

    // Invariante estricto: cero 5xx
    const has5xx = responses.some((r) => r.statusCode >= 500);
    expect(has5xx).toBe(false);

    // Exactamente 1 voto aceptado (201) y 19 rechazados por ya haber votado (409)
    const statusCounts = responses.reduce(
      (acc, r) => {
        acc[r.statusCode] = (acc[r.statusCode] ?? 0) + 1;
        return acc;
      },
      {} as Record<number, number>,
    );

    expect(statusCounts[201]).toBe(1);
    expect(statusCounts[409]).toBe(19);

    // Cada respuesta debe tener su correlation ID correspondiente reflejado
    responses.forEach((r, idx) => {
      expect(r.headers['x-request-id']).toBe(`burst-test-${idx}`);
    });
  });
});
