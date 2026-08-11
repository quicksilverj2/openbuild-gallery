import axios from 'axios';
import crypto from 'crypto';

const API_URL = process.env.API_URL || 'http://localhost:3001';
const WALLET_ID = 'probe-wallet-' + crypto.randomBytes(4).toString('hex');

async function runProbe() {
  console.log(`Starting wallet probe on ${API_URL} for wallet ${WALLET_ID}`);

  try {
    // 1. Create wallet
    await axios.post(`${API_URL}/wallets`, {
      id: WALLET_ID,
      initialBalance: 1000,
    });
    console.log('Wallet created with 1000 units');

    // 2. Fire 50 concurrent debits of 20 units each (Total 1000)
    console.log('Firing 50 concurrent debits of 20 units each...');
    const debits = Array.from({ length: 50 }).map((_, i) => 
      axios.post(`${API_URL}/wallets/${WALLET_ID}/debit`, {
        amount: 20,
        idempotencyKey: `probe-debit-${i}`,
      }).catch(err => {
        if (err.response?.status === 409) return { status: 409 };
        throw err;
      })
    );

    const results = await Promise.all(debits);
    const success = results.filter(r => r.status === 201 || r.status === 200).length;
    const conflicts = results.filter(r => r.status === 409).length;

    console.log(`Results: ${success} successful, ${conflicts} conflicts`);

    // 3. Verify balance is exactly 0
    const { data: wallet } = await axios.get(`${API_URL}/wallets/${WALLET_ID}`);
    console.log(`Final balance: ${wallet.balance}`);

    if (wallet.balance !== 0) {
      console.error('PROBE FAILED: Balance is not 0');
      process.exit(1);
    }

    // 4. Try one more debit (should fail with 400 Insufficient Funds)
    try {
      await axios.post(`${API_URL}/wallets/${WALLET_ID}/debit`, {
        amount: 1,
        idempotencyKey: 'probe-debit-overdraw',
      });
      console.error('PROBE FAILED: Overdraw allowed');
      process.exit(1);
    } catch (err) {
      if (err.response?.status === 400) {
        console.log('Overdraw correctly blocked');
      } else {
        throw err;
      }
    }

    console.log('PROBE PASSED');
  } catch (err) {
    console.error('PROBE FAILED with error:', err.message);
    if (err.response) {
      console.error('Response data:', err.response.data);
    }
    process.exit(1);
  }
}

runProbe();
