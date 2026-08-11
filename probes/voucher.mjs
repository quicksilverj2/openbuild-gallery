import fetch from 'node-fetch';

const baseUrl = process.argv[2] || 'http://localhost:3000';
const slug = 'voucher-probe';

async function run() {
  console.log('--- Voucher Invariant Probe ---');

  // 1. Setup
  await fetch(`${baseUrl}/clones/${slug}/vouchers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'PROBE-VOUCH' }),
  });

  // 2. Hammer it
  console.log('Bursting concurrent redeems...');
  const redeems = Array.from({ length: 10 }).map((_, i) =>
    fetch(`${baseUrl}/vouchers/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: 'PROBE-VOUCH',
        userId: `user-${i}`,
        idempotencyKey: `key-${i}`,
      }),
    })
  );

  const results = await Promise.all(redeems);
  const statusCounts = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});

  console.log('Status codes:', statusCounts);

  if (statusCounts[201] === 1 && statusCounts[409] === 9) {
    console.log('✅ INVARIANT MET: Exactly one winner, zero 5xx.');
  } else {
    console.log('❌ INVARIANT FAILED');
    process.exit(1);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
