#!/usr/bin/env node
// Live concurrency probe for the Poll clone — the same "reproduce under load"
// gate used on the take-homes, pointed at a running server (local or a PR preview).
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

// --- Shortlink clone (bounty #3) ---------------------------------------------
// Gate: 20 concurrent /shorten of the same URL (and same alias) → exactly one
// code wins; everyone else resolves to it; zero 5xx.

async function scenarioShortlinkSameUrl() {
  const burst = Number(process.env.SHORTEN_BURST ?? 20);
  const url = `https://probe.example/${id('same-url')}`;
  const results = await Promise.all(
    Array.from({ length: burst }, () => jpost('/shorten', { url })),
  );
  const statuses = results.map((r) => r.status);
  const d = dist(statuses);
  console.log(`\n[shortlink same URL × ${burst}] status distribution: ${JSON.stringify(d)}`);
  if (statuses.some((s) => s >= 500)) fail('shortlink same-URL burst returned a 5xx');
  else ok('shortlink same-URL: no 5xx');
  const codes = new Set(results.map((r) => r.json?.code).filter(Boolean));
  if (codes.size === 1) ok(`shortlink same-URL: exactly one code (${[...codes][0]})`);
  else fail(`shortlink same-URL: expected 1 unique code, got ${codes.size}`);
  const code = [...codes][0];
  if (code) {
    const redir = await fetch(`${BASE}/${code}`, { redirect: 'manual' });
    if (redir.status === 302 && redir.headers.get('location') === url) {
      ok('shortlink same-URL: redirect resolves to target');
    } else {
      fail(`shortlink same-URL: bad redirect status=${redir.status}`);
    }
  }
}

async function scenarioShortlinkSameAlias() {
  const burst = Number(process.env.SHORTEN_BURST ?? 20);
  const alias = id('alias').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
  const url = `https://probe.example/${id('same-alias')}`;
  const results = await Promise.all(
    Array.from({ length: burst }, () => jpost('/shorten', { url, alias })),
  );
  const statuses = results.map((r) => r.status);
  const d = dist(statuses);
  console.log(`\n[shortlink same alias × ${burst}] status distribution: ${JSON.stringify(d)}`);
  if (statuses.some((s) => s >= 500)) fail('shortlink same-alias burst returned a 5xx');
  else ok('shortlink same-alias: no 5xx');
  const codes = new Set(results.map((r) => r.json?.code).filter(Boolean));
  if (codes.size === 1 && [...codes][0] === alias) {
    ok(`shortlink same-alias: all resolved to alias ${alias}`);
  } else {
    fail(`shortlink same-alias: expected only ${alias}, got ${JSON.stringify([...codes])}`);
  }
}

console.log(`Concurrency probe → ${BASE} (burst=${N})`);
try {
  await scenarioSameVoter();
  await scenarioIdempotentRetry();
  await scenarioDistinctVoters();
  await scenarioShortlinkSameUrl();
  await scenarioShortlinkSameAlias();
} catch (e) {
  console.error(`\nprobe aborted: ${e.message}`);
  process.exit(2);
}

if (failures > 0) {
  console.error(`\n✗ probe FAILED with ${failures} invariant violation(s)`);
  process.exit(1);
}
console.log('\n✓ all invariants held — zero 5xx, tallies exact, shortlinks unique');
