#!/usr/bin/env node
// Concurrency probe for the Shortlink clone bounty.
// Gate: 20 concurrent POST /shorten with the SAME url → exactly one 201,
// the rest 200 (deduped), zero 5xx. Codes must be non-enumerable (checked
// by verifying they are base64url and >= 8 chars).

const BASE = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');
const N = Number(process.env.BURST ?? 20);

let failures = 0;
const fail = (msg) => { failures++; console.error(`  ✗ ${msg}`); };
const ok = (msg) => console.log(`  ✓ ${msg}`);

async function jpost(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json };
}

async function jget(path) {
  const res = await fetch(`${BASE}${path}`, { redirect: 'manual' });
  return { status: res.status, location: res.headers.get('location') };
}

console.log(`Shortlink concurrency probe → ${BASE} (burst=${N})`);

// Scenario 1: Same URL, no alias — must dedupe to exactly one code
const targetUrl = `https://dedupe-probe.example.com/${Date.now()}-${Math.random()}`;
const results = await Promise.all(
  Array.from({ length: N }, () => jpost('/shorten', { url: targetUrl }))
);

const statuses = results.map(r => r.status);
const dist = statuses.reduce((a, s) => ((a[s] = (a[s] ?? 0) + 1), a), {});
console.log(`\n[same url × ${N}] status distribution: ${JSON.stringify(dist)}`);

if (statuses.some(s => s >= 500)) fail('server returned a 5xx under burst');
else ok('no 5xx');

const created = results.filter(r => r.status === 201);
const deduped = results.filter(r => r.status === 200);

if (created.length === 1) ok('exactly one 201 (winner)');
else fail(`expected exactly one 201, got ${created.length}`);

if (deduped.length === N - 1) ok(`exactly ${N - 1} deduped (200)`);
else fail(`expected ${N - 1} deduped, got ${deduped.length}`);

// All responses must return the same code
const codes = results.map(r => r.json?.code).filter(Boolean);
const uniqueCodes = new Set(codes);
if (uniqueCodes.size === 1) ok('all responses share the same code');
else fail(`expected 1 unique code, got ${uniqueCodes.size}: ${[...uniqueCodes].join(', ')}`);

// Code must be non-enumerable: base64url, >= 8 chars
const code = codes[0];
if (code && /^[A-Za-z0-9_-]{8,}$/.test(code)) ok(`code is non-enumerable (${code.length} chars)`);
else fail(`code looks enumerable or too short: "${code}"`);

// Redirect must work
if (code) {
  const redir = await jget(`/${code}`);
  if (redir.status === 302 || redir.status === 301) ok(`GET /${code} redirects (${redir.status})`);
  else fail(`GET /${code} returned ${redir.status}, expected 301/302`);
  if (redir.location === targetUrl) ok('redirect target matches original URL');
  else fail(`redirect target mismatch: ${redir.location}`);
}

// Scenario 2: Alias collision — 20 concurrent with same alias, different URLs
const alias = `alias-probe-${Date.now()}`;
const aliasResults = await Promise.all(
  Array.from({ length: N }, (_, i) =>
    jpost('/shorten', { url: `https://alias-probe-${i}.example.com`, alias })
  )
);
const aliasStatuses = aliasResults.map(r => r.status);
const aliasDist = aliasStatuses.reduce((a, s) => ((a[s] = (a[s] ?? 0) + 1), a), {});
console.log(`\n[alias collision × ${N}] status distribution: ${JSON.stringify(aliasDist)}`);

if (aliasStatuses.some(s => s >= 500)) fail('alias collision produced 5xx');
else ok('no 5xx on alias collision');

const aliasWinners = aliasResults.filter(r => r.status === 201);
if (aliasWinners.length === 1) ok('exactly one alias winner (201)');
else fail(`expected 1 alias winner, got ${aliasWinners.length}`);

const aliasConflicts = aliasResults.filter(r => r.status === 409);
if (aliasConflicts.length === N - 1) ok(`${N - 1} alias conflicts (409)`);
else fail(`expected ${N - 1} conflicts, got ${aliasConflicts.length}`);

if (failures > 0) {
  console.error(`\n✗ probe FAILED with ${failures} violation(s)`);
  process.exit(1);
}
console.log('\n✓ all shortlink invariants held — zero 5xx, dedup correct, codes non-enumerable');
