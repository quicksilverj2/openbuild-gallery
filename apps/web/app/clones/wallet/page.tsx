'use client';

import { useState } from 'react';
import { api, type Wallet } from '@/lib/api';

export default function WalletClone() {
  const [ownerId, setOwnerId] = useState('');
  const [initialPaise, setInitialPaise] = useState(10000);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [amount, setAmount] = useState(1000);
  const [txKey, setTxKey] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    setMsg(null);
    try {
      const w = await api.createWallet('wallet', ownerId, initialPaise);
      setWallet(w);
      setMsg(`Wallet created. ID: ${w.id}. Balance: ${w.balancePaise} paise`);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function transfer() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.transfer('wallet', fromId, toId, amount, txKey);
      setMsg(res.status === 'transferred' ? `Transferred ${amount} paise.` : 'Duplicate (idempotent).');
    } catch (e) {
      const m = (e as Error).message;
      setMsg(m === 'insufficient_balance' ? 'Insufficient balance.' : m === 'idempotency_key_conflict' ? 'Key reused with different body.' : m);
    } finally {
      setBusy(false);
    }
  }

  async function checkBalance() {
    setBusy(true);
    setMsg(null);
    try {
      const w = await api.getWallet(fromId);
      setMsg(`Balance: ${w.balancePaise} paise (${(Number(w.balancePaise) / 100).toFixed(2)} rupees)`);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <p><a href="/">&larr; Gallery</a></p>
      <header className="masthead">
        <h1>Wallet <span className="pill">atomic + ledger</span></h1>
        <p>Atomic transfers, append-only ledger, integer paise. Balance never goes negative.</p>
      </header>

      <section style={{ marginTop: 24 }}>
        <h3>Create wallet</h3>
        <label className="muted">Owner ID</label>
        <input className="input" value={ownerId} onChange={(e) => setOwnerId(e.target.value)} style={{ margin: '6px 0 14px' }} placeholder="alice" />
        <label className="muted">Initial balance (paise)</label>
        <input className="input" type="number" min={0} value={initialPaise} onChange={(e) => setInitialPaise(Number(e.target.value))} style={{ margin: '6px 0 14px', width: 200 }} />
        <button className="btn" onClick={create} disabled={busy || !ownerId}>{busy ? 'Creating...' : 'Create wallet'}</button>
      </section>

      {wallet && (
        <section style={{ marginTop: 20 }}>
          <div className="card">
            <h3>Wallet Created</h3>
            <p><strong>ID:</strong> <code>{wallet.id}</code></p>
            <p><strong>Owner:</strong> {wallet.ownerId}</p>
            <p><strong>Balance:</strong> {wallet.balancePaise} paise</p>
          </div>
        </section>
      )}

      <section style={{ marginTop: 28 }}>
        <h3>Transfer</h3>
        <label className="muted">From wallet ID</label>
        <input className="input" value={fromId} onChange={(e) => setFromId(e.target.value)} style={{ margin: '6px 0 14px' }} placeholder="from wallet id" />
        <label className="muted">To wallet ID</label>
        <input className="input" value={toId} onChange={(e) => setToId(e.target.value)} style={{ margin: '6px 0 14px' }} placeholder="to wallet id" />
        <label className="muted">Amount (paise)</label>
        <input className="input" type="number" min={1} value={amount} onChange={(e) => setAmount(Number(e.target.value))} style={{ margin: '6px 0 14px', width: 200 }} />
        <label className="muted">Idempotency key</label>
        <input className="input" value={txKey} onChange={(e) => setTxKey(e.target.value)} style={{ margin: '6px 0 14px' }} placeholder="tx-001" />
        <div className="row" style={{ gap: 10 }}>
          <button className="btn" onClick={transfer} disabled={busy || !fromId || !toId || !txKey}>{busy ? 'Transferring...' : 'Transfer'}</button>
          <button className="btn" onClick={checkBalance} disabled={busy || !fromId}>Check balance</button>
        </div>
      </section>

      {msg && <p className="muted" style={{ marginTop: 16 }}>{msg}</p>}
    </main>
  );
}
