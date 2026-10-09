#!/usr/bin/env node
// Live probe for the Paste clone: 20 concurrent reads of a 1-view paste must
// serve content exactly once, with zero 5xx.   node probes/paste.mjs http://localhost:3000
const BASE = (process.argv[2] ?? 'http://localhost:3000').replace(/\/$/, '');
const N = Number(process.env.BURST ?? 20);
let failures = 0;
const check = (cond, msg) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failures++;
};

const created = await fetch(`${BASE}/clones/paste/pastes`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ content: 'probe', viewsAllowed: 1, ttlSeconds: 60 }),
});
check(created.status === 201, `create paste -> ${created.status}`);
const { id } = await created.json();
const codes = (
  await Promise.all(Array.from({ length: N }, () => fetch(`${BASE}/pastes/${id}`)))
).map((r) => r.status);
check(codes.filter((c) => c >= 500).length === 0, 'zero 5xx');
check(codes.filter((c) => c === 200).length === 1, `exactly one of ${N} reads served`);
check(codes.filter((c) => c === 404).length === N - 1, 'all others 404');
process.exit(failures ? 1 : 0);
