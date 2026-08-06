#!/usr/bin/env node
// Live concurrency probe for the Shortlink clone.
//
//   node probes/concurrency-shortlink.mjs http://localhost:3000
//
// Exits NON-ZERO if any invariant breaks or any request returns a 5xx.
// Acceptance criteria from issue #3:
//   20 concurrent /shorten of the same URL → exactly one code wins,
//   the rest resolve to it — no 500s, no duplicate codes.

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

async function jget(path, allowNonJson) {
  const res = await fetch(`${BASE}${path}`, { redirect: 'manual' });
  if (allowNonJson && res.status >= 300 && res.status < 400) {
    return { status: res.status, location: res.headers.get('location') };
  }
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

// Scenario: 20 concurrent /shorten of the same URL → one code, no 5xx
async function scenarioSameUrlConcurrent() {
  const url = `https://example.com/${RUN}`;
  const results = await Promise.all(
    Array.from({ length: N }, () =>
      jpost('/shorten', { url }),
    ),
  );
  const statuses = results.map((r) => r.status);
  const d = dist(statuses);
  console.log(`\n[same URL concurrent × ${N}] status distribution: ${JSON.stringify(d)}`);

  if (statuses.some((s) => s >= 500)) fail('server returned a 5xx under the burst');
  else ok('no 5xx');

  // Exactly one created (201), rest are idempotent (200)
  const created = d[201] ?? 0;
  const dupes = d[200] ?? 0;
  if (created === 1) ok(`exactly one shortlink created (201): ${created}`);
  else fail(`expected exactly one 201, got ${created}`);

  // All responses must return the same code
  const codes = new Set(results.filter((r) => r.json?.code).map((r) => r.json.code));
  if (codes.size === 1) ok(`all responses returned the same code: "${[...codes][0]}"`);
  else fail(`responses returned ${codes.size} different codes: ${[...codes]}`);

  // Verify redirect works
  const code = [...codes][0];
  const redir = await jget(`/s/${code}`, true);
  if (redir.status === 302) ok(`GET /s/${code} → 302 redirect`);
  else fail(`expected 302 redirect, got ${redir.status}`);

  if (redir.location === url) ok(`redirect location matches original URL`);
  else fail(`redirect location mismatch: expected ${url}, got ${redir.location}`);
}

// Scenario: 20 concurrent /shorten with the SAME alias → one wins, rest resolve
async function scenarioSameAliasConcurrent() {
  const url1 = `https://a.example.com/${RUN}-1`;
  const url2 = `https://a.example.com/${RUN}-2`;
  const alias = `alias-${RUN}`;

  // First request establishes the alias → url1
  const first = await jpost('/shorten', { url: url1, alias });
  if (first.status !== 201) fail(`first alias request failed (status ${first.status})`);

  // 20 concurrent requests with same alias, different URL → first 409, rest resolve to url1
  const results = await Promise.all(
    Array.from({ length: N }, () =>
      jpost('/shorten', { url: url2, alias }),
    ),
  );
  const statuses = results.map((r) => r.status);
  const d = dist(statuses);
  console.log(`\n[same alias conflict × ${N}] status distribution: ${JSON.stringify(d)}`);

  if (statuses.some((s) => s >= 500)) fail('server returned a 5xx');
  else ok('no 5xx');

  if (d[409] === N) ok(`all ${N} concurrent alias attempts returned 409`);
  else fail(`expected ${N} × 409, got ${d[409] ?? 0} × 409`);
}

// Scenario: /s/:code 404 for non-existent
async function scenarioNotFound() {
  const { status } = await jget(`/s/no-way-this-exists-${RUN}`, true);
  if (status === 404) ok('non-existent shortlink returns 404');
  else fail(`expected 404, got ${status}`);
}

console.log(`Shortlink concurrency probe → ${BASE} (burst=${N})`);
try {
  await scenarioSameUrlConcurrent();
  await scenarioSameAliasConcurrent();
  await scenarioNotFound();
} catch (e) {
  console.error(`\nprobe aborted: ${e.message}`);
  process.exit(2);
}

if (failures > 0) {
  console.error(`\n✗ probe FAILED with ${failures} invariant violation(s)`);
  process.exit(1);
}
console.log('\n✓ all invariants held — zero 5xx, dedup correct, redirects work');
