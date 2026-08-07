'use client';

import { useState } from 'react';
import { api, type Voucher } from '@/lib/api';

export default function VoucherClone() {
  const [code, setCode] = useState('');
  const [voucher, setVoucher] = useState<Voucher | null>(null);
  const [redeemId, setRedeemId] = useState('');
  const [userId, setUserId] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    setMsg(null);
    try {
      const v = await api.createVoucher('voucher', code);
      setVoucher(v);
      setMsg(`Voucher created. ID: ${v.id}`);
    } catch (e) {
      const m = (e as Error).message;
      setMsg(m === 'voucher_code_taken' ? 'Code already taken.' : m);
    } finally {
      setBusy(false);
    }
  }

  async function redeem() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.redeemVoucher(redeemId, userId);
      setMsg(res.status === 'redeemed' ? 'Voucher redeemed!' : 'Already redeemed (idempotent).');
    } catch (e) {
      const m = (e as Error).message;
      setMsg(m === 'voucher_taken' ? 'Voucher already taken by another user.' : m === 'voucher_not_found' ? 'Voucher not found.' : m);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <p>
        <a href="/">&larr; Gallery</a>
      </p>
      <header className="masthead">
        <h1>
          Voucher <span className="pill">single-use + idempotent</span>
        </h1>
        <p>Create a single-use voucher. Redeem exactly once. Same user retrying is a no-op.</p>
      </header>

      <section style={{ marginTop: 24 }}>
        <label className="muted">Voucher code</label>
        <input
          className="input"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          style={{ margin: '6px 0 14px' }}
          placeholder="SUMMER2026"
        />
        <button className="btn" onClick={create} disabled={busy || !code}>
          {busy ? 'Creating...' : 'Create voucher'}
        </button>
      </section>

      {voucher && (
        <section style={{ marginTop: 20 }}>
          <div className="card">
            <h3>Voucher Created</h3>
            <p><strong>ID:</strong> <code>{voucher.id}</code></p>
            <p><strong>Code:</strong> {voucher.code}</p>
          </div>
        </section>
      )}

      <section style={{ marginTop: 28 }}>
        <h3>Redeem a voucher</h3>
        <label className="muted">Voucher ID</label>
        <input
          className="input"
          value={redeemId}
          onChange={(e) => setRedeemId(e.target.value)}
          style={{ margin: '6px 0 14px' }}
          placeholder="Enter voucher ID..."
        />
        <label className="muted">User ID</label>
        <input
          className="input"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          style={{ margin: '6px 0 14px' }}
          placeholder="Enter your user ID..."
        />
        <button className="btn" onClick={redeem} disabled={busy || !redeemId || !userId}>
          {busy ? 'Redeeming...' : 'Redeem'}
        </button>
      </section>

      {msg && (
        <p className="muted" style={{ marginTop: 16 }}>
          {msg}
        </p>
      )}
    </main>
  );
}
