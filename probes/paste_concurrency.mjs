#!/usr/bin/env node
// Live concurrency probe for the Paste clone (view-once)
//
//   node probes/paste_concurrency.mjs http://localhost:3000
//
// Validates invariant: 20 concurrent reads of a 1-view paste → exactly ONE 200, 19 404s, ZERO 5xx.

const BASE = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');
const N = Number(process.env.BURST ?? 20);

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
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function newPaste(content = 'Live probe confidential test', viewsAllowed = 1) {
  const r = await jpost('/clones/paste/pastes', { content, viewsAllowed });
  if (r.status !== 201) throw new Error(`could not create paste (status ${r.status})`);
  return r.json;
}

function dist(statuses) {
  return statuses.reduce((acc, s) => ((acc[s] = (acc[s] ?? 0) + 1), acc), {});
}

async function scenarioViewOnceBurst() {
  const paste = await newPaste('View-once secret under concurrent race', 1);
  console.log(`\n[*] Scenario 1: ${N} concurrent reads on 1-view paste (id: ${paste.id})`);

  const results = await Promise.all(Array.from({ length: N }, () => jget(`/pastes/${paste.id}`)));

  const statuses = results.map((r) => r.status);
  const d = dist(statuses);
  console.log(`[status distribution] ${JSON.stringify(d)}`);

  if (statuses.some((s) => s >= 500)) fail('Server returned a 5xx under race');
  else ok('Zero 5xx errors');

  if (d[200] === 1) ok('Exactly one reader served (200)');
  else fail(`Expected exactly one 200, got ${d[200] ?? 0}`);

  if (d[404] === N - 1) ok(`Remaining ${N - 1} readers got 404`);
  else fail(`Expected ${N - 1} 404s, got ${d[404] ?? 0}`);
}

async function scenarioMultiViewBurst() {
  const paste = await newPaste('5-view secret burst', 5);
  console.log(`\n[*] Scenario 2: ${N} concurrent reads on 5-view paste (id: ${paste.id})`);

  const results = await Promise.all(Array.from({ length: N }, () => jget(`/pastes/${paste.id}`)));

  const statuses = results.map((r) => r.status);
  const d = dist(statuses);
  console.log(`[status distribution] ${JSON.stringify(d)}`);

  if (statuses.some((s) => s >= 500)) fail('Server returned a 5xx');
  else ok('Zero 5xx errors');

  if (d[200] === 5) ok('Exactly 5 readers served (200)');
  else fail(`Expected exactly 5 200s, got ${d[200] ?? 0}`);

  if (d[404] === N - 5) ok(`Remaining ${N - 5} readers got 404`);
  else fail(`Expected ${N - 5} 404s, got ${d[404] ?? 0}`);
}

console.log(`Paste Concurrency Probe → ${BASE} (burst=${N})`);
try {
  await scenarioViewOnceBurst();
  await scenarioMultiViewBurst();
} catch (e) {
  console.error(`\nProbe aborted: ${e.message}`);
  process.exit(2);
}

if (failures > 0) {
  console.error(`\n✗ Probe FAILED with ${failures} invariant violation(s)`);
  process.exit(1);
}
console.log('\n✓ All paste invariants held — zero 5xx, atomic view counts exact.');
