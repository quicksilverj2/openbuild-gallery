import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { prisma } from '../src/db';

let app: FastifyInstance;
const capturedLogs: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  const logStream = new PassThrough();
  logStream.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        capturedLogs.push(JSON.parse(trimmed));
      } catch {
        // ignore non-json lines
      }
    }
  });

  app = buildApp({ logStream });
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

async function newPoll(): Promise<{ pollId: string; optionA: string; optionB: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/clones/poll/polls',
    payload: { question: 'Best clone?', options: ['A', 'B'] },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return { pollId: body.id, optionA: body.options[0].id, optionB: body.options[1].id };
}

function vote(pollId: string, payload: Record<string, string>, headers?: Record<string, string>) {
  return app.inject({ method: 'POST', url: `/polls/${pollId}/votes`, payload, headers });
}

function distribution(codes: number[]): Record<number, number> {
  return codes.reduce<Record<number, number>>((acc, c) => {
    acc[c] = (acc[c] ?? 0) + 1;
    return acc;
  }, {});
}

describe('poll voting — happy path', () => {
  it('counts a single vote', async () => {
    const { pollId, optionA } = await newPoll();
    const res = await vote(pollId, { optionId: optionA, voterId: 'u1', idempotencyKey: 'k1' });
    expect(res.statusCode).toBe(201);
    expect(res.json().tally.total).toBe(1);
  });

  it('404s an option that belongs to another poll', async () => {
    const p1 = await newPoll();
    const p2 = await newPoll();
    const res = await vote(p1.pollId, {
      optionId: p2.optionA,
      voterId: 'u1',
      idempotencyKey: 'x1',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('invariant: one vote per voter under a concurrent burst', () => {
  it('50 concurrent votes from the SAME voter count exactly once, with zero 5xx', async () => {
    const { pollId, optionA } = await newPoll();
    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        vote(pollId, { optionId: optionA, voterId: 'same-voter', idempotencyKey: `key-${i}` }),
      ),
    );
    const codes = results.map((r) => r.statusCode);
    const dist = distribution(codes);

    expect(codes.filter((c) => c >= 500)).toHaveLength(0); // no server errors under the race
    expect(dist[201]).toBe(1); // exactly one winner
    expect(dist[409]).toBe(N - 1); // everyone else cleanly rejected

    const tally = (await app.inject({ method: 'GET', url: `/polls/${pollId}` })).json().tally;
    expect(tally.total).toBe(1);
  });
});

describe('invariant: idempotent retries', () => {
  it('50 concurrent identical retries (same key, same body) count once', async () => {
    const { pollId, optionA } = await newPoll();
    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        vote(pollId, { optionId: optionA, voterId: 'retrier', idempotencyKey: 'retry-key' }),
      ),
    );
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c >= 500)).toHaveLength(0);
    expect(codes.filter((c) => c === 201)).toHaveLength(1); // first write
    expect(codes.filter((c) => c === 200)).toHaveLength(N - 1); // replays, all "duplicate_ignored"

    const tally = (await app.inject({ method: 'GET', url: `/polls/${pollId}` })).json().tally;
    expect(tally.total).toBe(1);
  });

  it('same key + DIFFERENT body is refused with 409', async () => {
    const { pollId, optionA, optionB } = await newPoll();
    const first = await vote(pollId, { optionId: optionA, voterId: 'v', idempotencyKey: 'dup' });
    expect(first.statusCode).toBe(201);
    const second = await vote(pollId, { optionId: optionB, voterId: 'v', idempotencyKey: 'dup' });
    expect(second.statusCode).toBe(409);
  });
});

describe('invariant: distinct voters tally exactly', () => {
  it('50 distinct voters produce a tally of exactly 50, zero 5xx', async () => {
    const { pollId, optionA, optionB } = await newPoll();
    const N = 50;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        vote(pollId, {
          optionId: i % 2 === 0 ? optionA : optionB,
          voterId: `voter-${i}`,
          idempotencyKey: `k-${i}`,
        }),
      ),
    );
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((c) => c >= 500)).toHaveLength(0);
    expect(codes.filter((c) => c === 201)).toHaveLength(N);

    const tally = (await app.inject({ method: 'GET', url: `/polls/${pollId}` })).json().tally;
    expect(tally.total).toBe(N);
    expect(tally.options[0].votes + tally.options[1].votes).toBe(N);
  });
});

describe('observability: per-clone structured logs, correlation IDs, and /metrics', () => {
  it('correlates invariant events by x-request-id and exposes per-clone counters on /metrics', async () => {
    const { pollId, optionA } = await newPoll();
    const winnerCorrelationId = 'corr-winner-001';
    const loserCorrelationId = 'corr-loser-002';

    const winRes = await vote(
      pollId,
      { optionId: optionA, voterId: 'obs-voter', idempotencyKey: 'obs-key-1' },
      { 'x-request-id': winnerCorrelationId },
    );
    expect(winRes.statusCode).toBe(201);
    expect(winRes.headers['x-request-id']).toBe(winnerCorrelationId);

    const loseRes = await vote(
      pollId,
      { optionId: optionA, voterId: 'obs-voter', idempotencyKey: 'obs-key-2' },
      { 'x-request-id': loserCorrelationId },
    );
    expect(loseRes.statusCode).toBe(409);
    expect(loseRes.headers['x-request-id']).toBe(loserCorrelationId);

    const alreadyVotedLog = capturedLogs.find(
      (entry) =>
        entry.reqId === loserCorrelationId &&
        entry.event === 'vote.already_voted' &&
        entry.cloneSlug === 'poll' &&
        entry.invariant === 'race_lost',
    );
    expect(alreadyVotedLog).toBeDefined();

    const metricsRes = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metricsRes.statusCode).toBe(200);
    const body = metricsRes.body;
    expect(body).toContain('openbuild_clone_polls_total{clone="poll"}');
    expect(body).toContain('openbuild_clone_votes_total{clone="poll"}');
    expect(body).toContain('openbuild_clone_requests_total{clone="poll",method="POST",status="201"}');
    expect(body).toContain('openbuild_clone_requests_total{clone="poll",method="POST",status="409"}');
    expect(body).toContain('openbuild_clone_invariant_events_total{clone="poll",event="vote.already_voted"}');
    expect(body).toContain('openbuild_clone_invariant_events_total{clone="poll",event="race_lost"}');
  });
});
