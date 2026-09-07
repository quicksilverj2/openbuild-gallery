#!/usr/bin/env node
// Live concurrency probe for the Shortlink clone.
//   node probes/shortlink-concurrency.mjs http://localhost:3000

const BASE = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');
const N = Number(process.env.BURST ?? 50);
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

let failures = 0;
const fail = (msg) => {
  failures++;
  console.error(`  [FAIL] ${msg}`);
};
const ok = (msg) => console.log(`  [OK] ${msg}`);

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
  return { status: res.status, json: await res.json(), headers: res.headers };
}

function dist(statuses) {
  return statuses.reduce((acc, s) => ((acc[s] = (acc[s] ?? 0) + 1), acc), {});
}

async function scenarioCreate() {
  console.log('\n[create] single shortlink creation');
  const r = await jpost('/clones/shortlink/shortlinks', {
    url: 'https://example.com/probe-create',
  });
  if (r.status !== 201) return fail(`expected 201, got ${r.status}`);
  const { code, url } = r.json();
  if (!code || typeof code !== 'string') return fail('missing code');
  if (url !== 'https://example.com/probe-create') return fail('url mismatch');
  if (code.length < 4) return fail(`code too short: ${code}`);
  ok('shortlink created with valid code');
  const info = await jget(`/shortlinks/${code}/info`);
  if (info.status !== 200) return fail(`info returned ${info.status}`);
  if (info.json().url !== url) return fail('info url mismatch');
  ok('info endpoint returns correct data');
}

async function scenarioDedupSequential() {
  console.log('\n[dedup-sequential] same URL twice sequentially');
  const url = `https://example.com/probe-dedup-${RUN}`;
  const first = await jpost('/clones/shortlink/shortlinks', { url });
  if (first.status !== 201) return fail(`first create failed: ${first.status}`);
  const second = await jpost('/clones/shortlink/shortlinks', { url });
  if (second.status === 201) return fail('second create should have been 409');
  if (second.status !== 409) return fail(`expected 409, got ${second.status}`);
  if (second.json().error !== 'url_already_shortened') return fail('wrong error type');
  if (second.json().code !== first.json().code) return fail('codes should match');
  ok('URL deduplication works');
}

async function scenarioConcurrentSameUrl() {
  console.log(`\n[concurrent-same-url x ${N}] burst with identical URL`);
  const url = `https://example.com/probe-burst-same-${RUN}`;
  const results = await Promise.all(
    Array.from({ length: N }, () => jpost('/clones/shortlink/shortlinks', { url })),
  );
  const statuses = results.map((r) => r.status);
  const d = dist(statuses);
  console.log(`  distribution: ${JSON.stringify(d)}`);
  if (statuses.some((s) => s >= 500)) fail('server returned a 5xx');
  else ok('no 5xx');
  if (d[201] === 1) ok('exactly one 201 (winner)');
  else fail(`expected one 201, got ${d[201] ?? 0}`);
  if (d[409] === N - 1) ok(`exactly ${N - 1} 409s`);
  else fail(`expected ${N - 1} 409s, got ${d[409] ?? 0}`);
  const winner = results.find((r) => r.status === 201);
  if (winner) {
    const { code } = winner.json();
    const info = await jget(`/shortlinks/${code}/info`);
    if (info.status === 200 && info.json().url === url) ok('winner retrievable');
    else fail('winner not retrievable');
  }
}

async function scenarioConcurrentDifferentUrls() {
  console.log(`\n[concurrent-different-urls x ${N}] burst with distinct URLs`);
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      jpost('/clones/shortlink/shortlinks', { url: `https://example.com/distinct-${RUN}-${i}` }),
    ),
  );
  const statuses = results.map((r) => r.status);
  const d = dist(statuses);
  console.log(`  distribution: ${JSON.stringify(d)}`);
  if (statuses.some((s) => s >= 500)) fail('server returned a 5xx');
  else ok('no 5xx');
  if (d[201] === N) ok(`all ${N} succeeded (201)`);
  else fail(`expected ${N} 201s, got ${d[201] ?? 0}`);
  const codes = results.map((r) => r.json().code).filter(Boolean);
  if (new Set(codes).size === N) ok(`all ${N} codes unique`);
  else fail(`expected ${N} unique codes, got ${new Set(codes).size}`);
}

async function scenarioRedirect() {
  console.log('\n[redirect] 301 redirect to original URL');
  const targetUrl = `https://example.com/probe-redirect-${RUN}`;
  const createRes = await jpost('/clones/shortlink/shortlinks', { url: targetUrl });
  if (createRes.status !== 201) return fail('could not create shortlink');
  const { code } = createRes.json();
  const res = await jget(`/shortlinks/${code}`);
  if (res.status !== 301) return fail(`expected 301, got ${res.status}`);
  const location = res.headers.get('location');
  if (location !== targetUrl) return fail(`redirect mismatch: ${location}`);
  ok(`redirects to: ${targetUrl}`);
}

console.log(`Shortlink concurrency probe -> ${BASE} (burst=${N})`);
try {
  await scenarioCreate();
  await scenarioDedupSequential();
  await scenarioConcurrentSameUrl();
  await scenarioConcurrentDifferentUrls();
  await scenarioRedirect();
} catch (e) {
  console.error(`\nprobe aborted: ${e.message}`);
  process.exit(2);
}
if (failures > 0) {
  console.error(`\n[FAILED] ${failures} invariant violation(s)`);
  process.exit(1);
}
console.log('\n[PASSED] all invariants held');
