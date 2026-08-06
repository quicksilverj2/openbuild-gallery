'use client';

import { useState } from 'react';
import { api, type Poll, type Tally } from '@/lib/api';

// A stable per-browser voter id so "one vote per voter" is visible in the UI.
function voterId(): string {
  if (typeof window === 'undefined') return 'ssr';
  const k = 'obg-voter-id';
  let v = window.localStorage.getItem(k);
  if (!v) {
    v = `voter-${Math.random().toString(36).slice(2)}`;
    window.localStorage.setItem(k, v);
  }
  return v;
}

export default function PollClone() {
  const [poll, setPoll] = useState<Poll | null>(null);
  const [tally, setTally] = useState<Tally | null>(null);
  const [question, setQuestion] = useState('Which clone should we build next?');
  const [options, setOptions] = useState('Shortlink, Paste, Wallet');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    setMsg(null);
    try {
      const opts = options
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const p = await api.createPoll('poll', question, opts);
      setPoll(p);
      const fresh = await api.getPoll(p.id);
      setTally(fresh.tally ?? null);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function castVote(optionId: string) {
    if (!poll) return;
    setBusy(true);
    setMsg(null);
    try {
      // Idempotency key ties a retry to this (voter, poll) — a repeat click is a no-op.
      const key = `${voterId()}:${poll.id}`;
      const res = await api.vote(poll.id, optionId, voterId(), key);
      setTally(res.tally);
      setMsg(res.status === 'counted' ? 'Vote counted.' : 'Already counted (idempotent).');
    } catch (e) {
      const m = (e as Error).message;
      setMsg(m === 'already_voted' ? 'You already voted in this poll.' : m);
      // refresh tally so the UI stays truthful even on a rejected vote
      try {
        const fresh = await api.getPoll(poll.id);
        setTally(fresh.tally ?? null);
      } catch {
        /* ignore */
      }
    } finally {
      setBusy(false);
    }
  }

  const total = tally?.total ?? 0;

  return (
    <main>
      <p>
        <a href="/">← Gallery</a>
      </p>
      <header className="masthead">
        <h1>
          Poll <span className="pill">correct under load</span>
        </h1>
        <p>
          Create a poll, vote once, watch the live tally. One vote per browser; retries are no-ops.
        </p>
      </header>

      {!poll && (
        <section style={{ marginTop: 24 }}>
          <label className="muted">Question</label>
          <input
            className="input"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            style={{ margin: '6px 0 14px' }}
          />
          <label className="muted">Options (comma-separated)</label>
          <input
            className="input"
            value={options}
            onChange={(e) => setOptions(e.target.value)}
            style={{ margin: '6px 0 14px' }}
          />
          <button className="btn" onClick={create} disabled={busy}>
            {busy ? 'Creating…' : 'Create poll'}
          </button>
        </section>
      )}

      {poll && tally && (
        <section style={{ marginTop: 24 }}>
          <h3>{poll.question}</h3>
          {tally.options.map((o) => {
            const pct = total ? Math.round((o.votes / total) * 100) : 0;
            return (
              <div key={o.id} style={{ margin: '14px 0' }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <button className="btn" onClick={() => castVote(o.id)} disabled={busy}>
                    {o.text}
                  </button>
                  <span className="muted">
                    {o.votes} · {pct}%
                  </span>
                </div>
                <div style={{ marginTop: 6, background: '#0f1218', borderRadius: 6 }}>
                  <div className="bar" style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
          <p className="muted" style={{ marginTop: 16 }}>
            Total votes: {total}
            {msg ? ` — ${msg}` : ''}
          </p>
        </section>
      )}
    </main>
  );
}
