#!/usr/bin/env node
// Live concurrency probe for the Paste clone.
//
//   node probes/concurrency-paste.mjs http://localhost:3000
//
// Exits NON-ZERO if any invariant breaks or any request returns a 5xx.
// Acceptance criteria from issue #4:
//   20 concurrent reads of a 1-view paste → exactly one read is served
//   the content; the rest get 404/410 — zero 5xx.

const BASE = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');
const N = Number(process.env.BURST ?? 20);

const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

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
  let json;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

function dist(statuses) {
  return statuses.reduce((acc, s) => ((acc[s] = (acc[s] ?? 0) + 1), acc), {});
}

// Scenario: 20 concurrent reads of a 1-view paste → exactly one gets content
async function scenarioOneViewConcurrent() {
  // Create a paste with 1 view allowed
  const create = await jpost('/paste', {
    content: `concurrent probe ${RUN}`,
    viewsAllowed: 1,
    ttlSeconds: 300,
  });
  if (create.status !== 201) {
    fail(`failed to create paste (status ${create.status})`);
    return;
  }
  const id = create.json.id;
  ok(`created paste ${id}`);

  // 20 concurrent reads
  const results = await Promise.all(
    Array.from({ length: N }, () => jget(`/paste/${id}`)),
  );
  const statuses = results.map((r) => r.status);
  const d = dist(statuses);
  console.log(`\n[1-view paste × ${N} concurrent reads] status distribution: ${JSON.stringify(d)}`);

  if (statuses.some((s) => s >= 500)) fail('server returned a 5xx under the burst');
  else ok('no 5xx');

  // Exactly one read gets content (200)
  const got = d[200] ?? 0;
  if (got === 1) ok(`exactly one read got content (200): ${got}`);
  else fail(`expected exactly one 200, got ${got}`);

  // Rest get 410
  const exhausted = d[410] ?? 0;
  if (exhausted === N - 1) ok(`remaining ${N - 1} reads got 410`);
  else fail(`expected ${N - 1} × 410, got ${exhausted} × 410`);
}

// Scenario: 20 concurrent reads of a 5-view paste → exactly 5 get content
async function scenarioMultiViewConcurrent() {
  const views = 5;
  const create = await jpost('/paste', {
    content: `multi-view probe ${RUN}`,
    viewsAllowed: views,
    ttlSeconds: 300,
  });
  if (create.status !== 201) {
    fail(`failed to create paste (status ${create.status})`);
    return;
  }
  const id = create.json.id;
  ok(`created multi-view paste ${id} (${views} views)`);

  const results = await Promise.all(
    Array.from({ length: N }, () => jget(`/paste/${id}`)),
  );
  const statuses = results.map((r) => r.status);
  const d = dist(statuses);
  console.log(`\n[${views}-view paste × ${N} concurrent reads] status distribution: ${JSON.stringify(d)}`);

  if (statuses.some((s) => s >= 500)) fail('server returned a 5xx');
  else ok('no 5xx');

  const got = d[200] ?? 0;
  if (got === views) ok(`exactly ${views} reads got content (200): ${got}`);
  else fail(`expected ${views} × 200, got ${got} × 200`);

  const exhausted = d[410] ?? 0;
  const expectedExhausted = N - views;
  if (exhausted === expectedExhausted) ok(`remaining ${expectedExhausted} reads got 410`);
  else fail(`expected ${expectedExhausted} × 410, got ${exhausted} × 410`);
}

// Scenario: non-existent paste → 404
async function scenarioNotFound() {
  const { status } = await jget(`/paste/no-way-this-exists-${RUN}`);
  if (status === 404) ok('non-existent paste returns 404');
  else fail(`expected 404, got ${status}`);
}

// Scenario: expired paste → 410
async function scenarioExpired() {
  const create = await jpost('/paste', {
    content: `ephemeral ${RUN}`,
    ttlSeconds: 1,
  });
  if (create.status !== 201) {
    fail(`failed to create ephemeral paste (status ${create.status})`);
    return;
  }
  const id = create.json.id;
  ok(`created ephemeral paste ${id} (1s TTL)`);

  // Wait for expiration
  await new Promise((r) => setTimeout(r, 1100));

  const { status, json } = await jget(`/paste/${id}`);
  if (status === 410) ok('expired paste returns 410');
  else fail(`expected 410, got ${status}`);
}

console.log(`Paste concurrency probe → ${BASE} (burst=${N})`);
try {
  await scenarioOneViewConcurrent();
  await scenarioMultiViewConcurrent();
  await scenarioNotFound();
  await scenarioExpired();
} catch (e) {
  console.error(`\nprobe aborted: ${e.message}`);
  process.exit(2);
}

if (failures > 0) {
  console.error(`\n✗ probe FAILED with ${failures} invariant violation(s)`);
  process.exit(1);
}
console.log('\n✓ all invariants held — zero 5xx, view counting correct, 404/410 semantics work');
