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

async function seedAndProbe(): Promise<{ seedStatus: number; probeData: { polls: number; votes: number; clones: number } }> {
  const seedRes = await app.inject({ method: 'POST', url: '/admin/seed' });
  const clones = await prisma.clone.count();
  const polls = await prisma.poll.count();
  const votes = await prisma.vote.count();
  return { seedStatus: seedRes.statusCode, probeData: { clones, polls, votes } };
}

describe('preview-DB seeding + reset', () => {
  it('POST /admin/seed creates deterministic data', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/seed' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('seeded');

    const clones = await prisma.clone.findMany();
    expect(clones).toHaveLength(1);
    expect(clones[0].slug).toBe('poll');

    const polls = await prisma.poll.findMany();
    expect(polls).toHaveLength(1);
    expect(polls[0].question).toBe('Best framework?');

    const options = await prisma.option.findMany();
    expect(options).toHaveLength(3);

    const votes = await prisma.vote.findMany();
    expect(votes).toHaveLength(3);
  });

  it('two consecutive seed+probe runs give identical results', async () => {
    const first = await seedAndProbe();
    const second = await seedAndProbe();
    expect(first.seedStatus).toBe(200);
    expect(second.seedStatus).toBe(200);
    expect(first.probeData).toEqual(second.probeData);
  });

  it('POST /admin/reset clears all data', async () => {
    await app.inject({ method: 'POST', url: '/admin/seed' });
    const res = await app.inject({ method: 'POST', url: '/admin/reset' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('reset');

    expect(await prisma.clone.count()).toBe(0);
    expect(await prisma.poll.count()).toBe(0);
    expect(await prisma.vote.count()).toBe(0);
  });

  it('seed after reset works', async () => {
    await app.inject({ method: 'POST', url: '/admin/reset' });
    const res = await app.inject({ method: 'POST', url: '/admin/seed' });
    expect(res.statusCode).toBe(200);
    expect(await prisma.clone.count()).toBe(1);
    expect(await prisma.poll.count()).toBe(1);
    expect(await prisma.vote.count()).toBe(3);
  });

  it('seed is idempotent (running twice gives same state)', async () => {
    await app.inject({ method: 'POST', url: '/admin/seed' });
    const s1 = { c: await prisma.clone.count(), p: await prisma.poll.count(), v: await prisma.vote.count() };
    await app.inject({ method: 'POST', url: '/admin/seed' });
    const s2 = { c: await prisma.clone.count(), p: await prisma.poll.count(), v: await prisma.vote.count() };
    expect(s1).toEqual(s2);
  });
});

describe('no regression - poll still works after seed', () => {
  it('can create poll and vote after seeding', async () => {
    await app.inject({ method: 'POST', url: '/admin/seed' });
    const pollRes = await app.inject({
      method: 'POST',
      url: '/clones/poll/polls',
      payload: { question: 'Test after seed?', options: ['Yes', 'No'] },
    });
    expect(pollRes.statusCode).toBe(201);
    const pollId = pollRes.json().id;
    const optionA = pollRes.json().options[0].id;
    const voteRes = await app.inject({
      method: 'POST',
      url: `/polls/${pollId}/votes`,
      payload: { optionId: optionA, voterId: 'post-seed-voter', idempotencyKey: 'ps1' },
    });
    expect(voteRes.statusCode).toBe(201);
    expect(voteRes.json().tally.total).toBe(1);
  });
});
