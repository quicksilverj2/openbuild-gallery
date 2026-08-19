'use client';

import { useState } from 'react';
import { api, type Paste } from '@/lib/api';

export default function PasteClone() {
  const [content, setContent] = useState('');
  const [viewsAllowed, setViewsAllowed] = useState(1);
  const [ttlSeconds, setTtlSeconds] = useState<number | undefined>(undefined);
  const [createdPaste, setCreatedPaste] = useState<Paste | null>(null);

  const [lookupId, setLookupId] = useState('');
  const [fetchedPaste, setFetchedPaste] = useState<Paste | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleCreate() {
    if (!content.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const p = await api.createPaste('paste', content, viewsAllowed, ttlSeconds);
      setCreatedPaste(p);
      setLookupId(p.id);
      setMsg('Paste created! Share the ID or read it below.');
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRead() {
    if (!lookupId.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const p = await api.getPaste(lookupId.trim());
      setFetchedPaste(p);
      setMsg(`Paste read successfully. Views remaining: ${p.viewsLeft}`);
    } catch (e) {
      const m = (e as Error).message;
      setFetchedPaste(null);
      setMsg(
        m.includes('404') || m.includes('exhausted')
          ? 'Paste not found, expired, or views already exhausted.'
          : m,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <p>
        <a href="/">← Gallery</a>
      </p>
      <header className="masthead">
        <h1>
          Paste <span className="pill">view-once / atomic burn</span>
        </h1>
        <p>
          Self-destructing pastes with strict atomic read limits. When views reach 0 or TTL expires,
          the paste is burned forever.
        </p>
      </header>

      <section style={{ marginTop: 24 }}>
        <h3>Create a self-destructing paste</h3>
        <label className="muted">Secret Content</label>
        <textarea
          className="input"
          rows={4}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Enter secret text, keys, or credentials..."
          style={{ width: '100%', margin: '6px 0 14px', fontFamily: 'monospace' }}
        />

        <div className="row" style={{ gap: 16, marginBottom: 14 }}>
          <div>
            <label className="muted">Allowed Views</label>
            <input
              className="input"
              type="number"
              min={1}
              value={viewsAllowed}
              onChange={(e) => setViewsAllowed(Math.max(1, parseInt(e.target.value) || 1))}
              style={{ width: 120, margin: '6px 0 0' }}
            />
          </div>
          <div>
            <label className="muted">TTL (Seconds, optional)</label>
            <input
              className="input"
              type="number"
              min={1}
              value={ttlSeconds ?? ''}
              placeholder="e.g. 3600"
              onChange={(e) => setTtlSeconds(e.target.value ? parseInt(e.target.value) : undefined)}
              style={{ width: 160, margin: '6px 0 0' }}
            />
          </div>
        </div>

        <button className="btn" onClick={handleCreate} disabled={busy || !content.trim()}>
          {busy ? 'Creating…' : 'Create Paste'}
        </button>

        {createdPaste && (
          <div style={{ marginTop: 14, padding: 12, background: '#131822', borderRadius: 6 }}>
            <p className="muted">
              Paste ID: <code>{createdPaste.id}</code>
            </p>
            <p className="muted">Views allowed: {createdPaste.viewsAllowed}</p>
          </div>
        )}
      </section>

      <hr style={{ margin: '32px 0', borderColor: '#222838' }} />

      <section>
        <h3>Read / Burn a paste</h3>
        <label className="muted">Paste ID</label>
        <div className="row" style={{ gap: 8, margin: '6px 0 14px' }}>
          <input
            className="input"
            value={lookupId}
            onChange={(e) => setLookupId(e.target.value)}
            placeholder="Paste ID to read..."
            style={{ flex: 1 }}
          />
          <button className="btn" onClick={handleRead} disabled={busy || !lookupId.trim()}>
            {busy ? 'Reading…' : 'Read & Burn'}
          </button>
        </div>

        {fetchedPaste && (
          <div
            style={{
              marginTop: 14,
              padding: 16,
              background: '#0d1117',
              border: '1px solid #30363d',
              borderRadius: 6,
            }}
          >
            <h4>Decrypted Content:</h4>
            <pre style={{ margin: '8px 0', whiteSpace: 'pre-wrap', color: '#58a6ff' }}>
              {fetchedPaste.content}
            </pre>
            <p className="muted" style={{ fontSize: '0.85em' }}>
              Views left: {fetchedPaste.viewsLeft} / {fetchedPaste.viewsAllowed}
            </p>
          </div>
        )}

        {msg && (
          <p className="muted" style={{ marginTop: 14 }}>
            {msg}
          </p>
        )}
      </section>
    </main>
  );
}
