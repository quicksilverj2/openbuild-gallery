#!/usr/bin/env node
// Live concurrency probe for the Voucher clone.
//
//   node probes/concurrency-voucher.mjs http://localhost:3000
//
// Exits NON-ZERO if any invariant breaks or any request returns a 5xx.
// Acceptance criteria from issue #8:
//   20 concurrent redeems of one voucher → exactly one succeeds (200),
//   the rest get 409 — zero 5xx.

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

function dist(statuses) {
  return statuses.reduce((acc, s) => ((acc[s] = (acc[s] ?? 0) + 1), acc), {});
}

// Scenario: 20 concurrent redeems of one voucher → exactly one wins
async function scenarioConcurrentRedeem() {
  const code = `PROBE-${RUN}`;

  // Create a voucher
  const create = await jpost('/voucher', { code, value: 'probe voucher' });
  if (create.status !== 201) {
    fail(`failed to create voucher (status ${create.status})`);
    return;
  }
  ok(`created voucher ${code}`);

  // 20 concurrent redeems
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      jpost(`/voucher/${code}/redeem`, { userId: `probe-user-${i}` }),
    ),
  );
  const statuses = results.map((r) => r.status);
  const d = dist(statuses);
  console.log(`\n[1 voucher × ${N} concurrent redeems] status distribution: ${JSON.stringify(d)}`);

  if (statuses.some((s) => s >= 500)) fail('server returned a 5xx under the burst');
  else ok('no 5xx');

  // Exactly one redeem succeeds (200)
  const got = d[200] ?? 0;
  if (got === 1) ok(`exactly one redeem succeeded (200): ${got}`);
  else fail(`expected exactly one 200, got ${got}`);

  // Rest get 409
  const conflict = d[409] ?? 0;
  if (conflict === N - 1) ok(`remaining ${N - 1} redeems got 409`);
  else fail(`expected ${N - 1} × 409, got ${conflict} × 409`);
}

// Scenario: non-existent voucher → 404
async function scenarioNotFound() {
  const { status } = await jpost(`/voucher/no-way-this-exists-${RUN}/redeem`, {
    userId: 'alice',
  });
  if (status === 404) ok('non-existent voucher returns 404');
  else fail(`expected 404, got ${status}`);
}

// Scenario: already-redeemed → 409 (sequential, not concurrent)
async function scenarioAlreadyRedeemed() {
  const code = `ALREADY-${RUN}`;

  const create = await jpost('/voucher', { code, value: 'sequential test' });
  if (create.status !== 201) {
    fail(`failed to create voucher (status ${create.status})`);
    return;
  }

  const first = await jpost(`/voucher/${code}/redeem`, { userId: 'alice' });
  if (first.status !== 200) {
    fail(`first redeem should succeed, got ${first.status}`);
    return;
  }
  ok('first redeem succeeded');

  const second = await jpost(`/voucher/${code}/redeem`, { userId: 'bob' });
  if (second.status === 409) ok('second redeem returned 409 (already_redeemed)');
  else fail(`expected 409, got ${second.status}`);
}

console.log(`Voucher concurrency probe → ${BASE} (burst=${N})`);
try {
  await scenarioConcurrentRedeem();
  await scenarioNotFound();
  await scenarioAlreadyRedeemed();
} catch (e) {
  console.error(`\nprobe aborted: ${e.message}`);
  process.exit(2);
}

if (failures > 0) {
  console.error(`\n✗ probe FAILED with ${failures} invariant violation(s)`);
  process.exit(1);
}
console.log('\n✓ all invariants held — zero 5xx, exactly-once redemption, clean 404/409 semantics');
