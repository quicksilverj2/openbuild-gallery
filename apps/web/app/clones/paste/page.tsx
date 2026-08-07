'use client';

import { useState } from 'react';
import { api, type Paste as PasteType } from '@/lib/api';

export default function PasteClone() {
  const [content, setContent] = useState('');
  const [viewsAllowed, setViewsAllowed] = useState(1);
  const [ttlMinutes, setTtlMinutes] = useState(60);
  const [paste, setPaste] = useState<PasteType | null>(null);
  const [readContent, setReadContent] = useState<string | null>(null);
  const [readId, setReadId] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    setMsg(null);
    try {
      const p = await api.createPaste('paste', content, viewsAllowed, ttlMinutes * 60);
      setPaste(p);
      setMsg(`Paste created. ID: ${p.id}`);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function read() {
    setBusy(true);
    setMsg(null);
    setReadContent(null);
    try {
      const res = await api.readPaste(readId);
      setReadContent(res.content);
      setMsg(`Read OK. ${res.viewsRemaining} views remaining.`);
    } catch (e) {
      const m = (e as Error).message;
      setMsg(m === 'paste_expired' ? 'Paste has expired.' : m === 'paste_exhausted' ? 'No views remaining.' : m);
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
          Paste <span className="pill">view-once + TTL</span>
        </h1>
        <p>Create a paste with limited views and a time-to-live. Exactly N reads succeed.</p>
      </header>

      <section style={{ marginTop: 24 }}>
        <label className="muted">Content</label>
        <textarea
          className="input"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={4}
          style={{ margin: '6px 0 14px', resize: 'vertical' }}
          placeholder="Type your secret here..."
        />
        <div className="row" style={{ gap: 20, marginBottom: 14 }}>
          <div>
            <label className="muted">Views allowed</label>
            <input
              className="input"
              type="number"
              min={1}
              max={1000}
              value={viewsAllowed}
              onChange={(e) => setViewsAllowed(Number(e.target.value))}
              style={{ margin: '6px 0 0', width: 120 }}
            />
          </div>
          <div>
            <label className="muted">TTL (minutes)</label>
            <input
              className="input"
              type="number"
              min={1}
              max={43200}
              value={ttlMinutes}
              onChange={(e) => setTtlMinutes(Number(e.target.value))}
              style={{ margin: '6px 0 0', width: 120 }}
            />
          </div>
        </div>
        <button className="btn" onClick={create} disabled={busy || !content}>
          {busy ? 'Creating...' : 'Create paste'}
        </button>
      </section>

      {paste && (
        <section style={{ marginTop: 20 }}>
          <div className="card">
            <h3>Paste Created</h3>
            <p>
              <strong>ID:</strong> <code>{paste.id}</code>
            </p>
            <p>
              <strong>Views allowed:</strong> {paste.viewsAllowed}
            </p>
            <p>
              <strong>Expires at:</strong> {new Date(paste.expiresAt).toLocaleString()}
            </p>
          </div>
        </section>
      )}

      <section style={{ marginTop: 28 }}>
        <h3>Read a paste</h3>
        <label className="muted">Paste ID</label>
        <input
          className="input"
          value={readId}
          onChange={(e) => setReadId(e.target.value)}
          style={{ margin: '6px 0 14px' }}
          placeholder="Enter paste ID to read..."
        />
        <button className="btn" onClick={read} disabled={busy || !readId}>
          {busy ? 'Reading...' : 'Read paste'}
        </button>

        {readContent && (
          <div className="card" style={{ marginTop: 14 }}>
            <h3>Content</h3>
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 14 }}>
              {readContent}
            </pre>
          </div>
        )}
      </section>

      {msg && (
        <p className="muted" style={{ marginTop: 16 }}>
          {msg}
        </p>
      )}
    </main>
  );
}
