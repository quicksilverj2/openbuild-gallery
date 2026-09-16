import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildApp } from '../src/app';
import { prisma } from '../src/db';

let app;

beforeAll(async () => {
  process.env.RESET_TOKEN = 'test-token';
  process.env.DATABASE_URL = 'postgresql://decepticon:decepticon@127.0.0.1:5432/app?schema=public';
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  // Reset DB before each test to ensure clean state - direct Prisma cleanup
  await prisma.vote.deleteMany();
  await prisma.option.deleteMany();
  await prisma.poll.deleteMany();
  await prisma.rateLimit.deleteMany();
  // Re-seed default clone
  await prisma.clone.upsert({
    where: { slug: 'poll' },
    update: {},
    create: {
      slug: 'poll',
      title: 'Poll',
      summary: 'Create a question, vote once, watch a live tally. Correct under concurrent load.',
      demoPath: '/clones/poll',
    },
  });
});

describe('reset endpoint', () => {
  it('rejects without token', async () => {
    const res = await app.inject({ method: 'POST', url: '/reset' });
    expect(res.statusCode).toBe(403);
  });

  it('rejects with wrong token', async () => {
    const res = await app.inject({ method: 'POST', url: '/reset', headers: { 'x-reset-token': 'wrong' } });
    expect(res.statusCode).toBe(403);
  });

  it('resets and reseeds default clone', async () => {
    // reset should return success
    const resetRes = await app.inject({ method: 'POST', url: '/reset', headers: { 'x-reset-token': 'test-token' } });
    expect(resetRes.statusCode).toBe(200);
    // after reset, only default clone should exist
    const clonesRes = await app.inject({ method: 'GET', url: '/clones' });
    const clones = clonesRes.json().clones;
    expect(clones).toHaveLength(1);
    expect(clones[0].slug).toBe('poll');
    // no polls, no votes
    const pollCount = await prisma.poll.count();
    const voteCount = await prisma.vote.count();
    expect(pollCount).toBe(0);
    expect(voteCount).toBe(0);
  });

  it('clears all mutable data', async () => {
    // create some data via API (poll + vote)
    const pollRes = await app.inject({ method: 'POST', url: '/clones/poll/polls', payload: { question: 'Q?', options: ['A','B'] } });
    expect(pollRes.statusCode).toBe(201);
    const poll = pollRes.json();
    const voteRes = await app.inject({ method: 'POST', url: `/polls/${poll.id}/votes`, payload: { optionId: poll.options[0].id, voterId: 'v1', idempotencyKey: 'k1' } });
    expect(voteRes.statusCode).toBe(201);
    // verify data exists
    const pollCountBefore = await prisma.poll.count();
    const voteCountBefore = await prisma.vote.count();
    expect(pollCountBefore).toBe(1);
    expect(voteCountBefore).toBe(1);
    // reset
    const resetRes = await app.inject({ method: 'POST', url: '/reset', headers: { 'x-reset-token': 'test-token' } });
    expect(resetRes.statusCode).toBe(200);
    // verify cleared
    const pollCountAfter = await prisma.poll.count();
    const voteCountAfter = await prisma.vote.count();
    expect(pollCountAfter).toBe(0);
    expect(voteCountAfter).toBe(0);
  });
});