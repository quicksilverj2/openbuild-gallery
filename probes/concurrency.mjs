#!/usr/bin/env node
// Live concurrency probe for the Gallery clones (Poll, Shortlink, ...) — the same
// "reproduce under load" gate used on the take-homes, pointed at a running server.
//
//   node probes/concurrency.mjs http://localhost:3000
//
// Exits NON-ZERO if any invariant breaks or any request returns a 5xx. The CI
// gate and the reviewer bot both run exactly this against the PR's preview URL.

const BASE = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');
const N = Number(process.env.BURST ?? 50);

// Namespace every voter/key to this run so the probe is deterministic on repeat
// runs and never collides with leftover data (bounty #9's re-runnability property).
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const id = (s) => `${RUN}:${s}`;

let failures = 0;
const fail = (msg) => {
  failures++;
  console.error(`  ✗ ${msg}`);
};
const ok = (msg) => console.log(`  ✓ ${msg}`);

async function jpost(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function jget(path) {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, json: await res.json() };
}

async function newPoll() {
  const r = await jpost('/clones/poll/polls', { question: 'Best clone?', options: ['A', 'B'] });
  if (r.status !== 201) throw new Error(`could not create poll (status ${r.status})`);
  return { pollId: r.json.id, optionA: r.json.options[0].id, optionB: r.json.options[1].id };
}

function dist(statuses) {
  return statuses.reduce((acc, s) => ((acc[s] = (acc[s] ?? 0) + 1), acc), {});
}

async function scenarioSameVoter() {
  const { pollId, optionA } = await newPoll();
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      jpost(`/polls/${pollId}/votes`, {
        optionId: optionA,
        voterId: id('same-voter'),
        idempotencyKey: id(`key-${i}`),
      }),
    ),
  );
  const statuses = results.map((r) => r.status);
  const d = dist(statuses);
  console.log(`\n[same voter × ${N}] status distribution: ${JSON.stringify(d)}`);
  if (statuses.some((s) => s >= 500)) fail('server returned a 5xx under the burst');
  else ok('no 5xx');
  if (d[201] === 1) ok('exactly one vote counted (201)');
  else fail(`expected exactly one 201, got ${d[201] ?? 0}`);
  const { json } = await jget(`/polls/${pollId}`);
  if (json.tally.total === 1) ok('final tally total = 1');
  else fail(`expected tally total 1, got ${json.tally.total}`);
}

async function scenarioIdempotentRetry() {
  const { pollId, optionA } = await newPoll();
  const results = await Promise.all(
    Array.from({ length: N }, () =>
      jpost(`/polls/${pollId}/votes`, {
        optionId: optionA,
        voterId: id('retrier'),
        idempotencyKey: id('retry-key'),
      }),
    ),
  );
  const statuses = results.map((r) => r.status);
  const d = dist(statuses);
  console.log(`\n[same idempotency key × ${N}] status distribution: ${JSON.stringify(d)}`);
  if (statuses.some((s) => s >= 500)) fail('server returned a 5xx under retry burst');
  else ok('no 5xx');
  const { json } = await jget(`/polls/${pollId}`);
  if (json.tally.total === 1) ok('retries counted exactly once (tally = 1)');
  else fail(`expected tally total 1, got ${json.tally.total}`);
}

async function scenarioDistinctVoters() {
  const { pollId, optionA, optionB } = await newPoll();
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      jpost(`/polls/${pollId}/votes`, {
        optionId: i % 2 === 0 ? optionA : optionB,
        voterId: id(`voter-${i}`),
        idempotencyKey: id(`k-${i}`),
      }),
    ),
  );
  const statuses = results.map((r) => r.status);
  const d = dist(statuses);
  console.log(`\n[distinct voters × ${N}] status distribution: ${JSON.stringify(d)}`);
  if (statuses.some((s) => s >= 500)) fail('server returned a 5xx');
  else ok('no 5xx');
  const { json } = await jget(`/polls/${pollId}`);
  if (json.tally.total === N) ok(`tally total = ${N} (exact)`);
  else fail(`expected tally total ${N}, got ${json.tally.total}`);
}

async function scenarioShortlinkBurst() {
  const url = `https://invariant.test/probe-${id('url')}`;
  const burstN = 20;
  const results = await Promise.all(
    Array.from({ length: burstN }, () => jpost('/shorten', { url })),
  );
  const statuses = results.map((r) => r.status);
  const d = dist(statuses);
  console.log(
    `\n[shortlink concurrent burst × ${burstN}] status distribution: ${JSON.stringify(d)}`,
  );
  if (statuses.some((s) => s >= 500)) fail('server returned a 5xx under shortlink burst');
  else ok('no 5xx');
  if (d[201] === 1) ok('exactly one shortlink created (201)');
  else fail(`expected exactly one 201, got ${d[201] ?? 0}`);
  if (d[200] === burstN - 1) ok('all concurrent requests resolved to winner (200)');
  else fail(`expected ${burstN - 1} 200s, got ${d[200] ?? 0}`);

  const codes = new Set(results.map((r) => r.json?.code));
  if (codes.size === 1) ok('all requests returned identical code');
  else fail(`expected 1 unique code, got ${codes.size}`);
}

console.log(`Concurrency probe → ${BASE} (burst=${N})`);
try {
  await scenarioSameVoter();
  await scenarioIdempotentRetry();
  await scenarioDistinctVoters();
  await scenarioShortlinkBurst();
} catch (e) {
  console.error(`\nprobe aborted: ${e.message}`);
  process.exit(2);
}

if (failures > 0) {
  console.error(`\n✗ probe FAILED with ${failures} invariant violation(s)`);
  process.exit(1);
}
console.log('\n✓ all invariants held — zero 5xx, tallies exact');
