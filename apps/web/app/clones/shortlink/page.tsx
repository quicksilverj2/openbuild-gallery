'use client';

import { useState } from 'react';
import { api, API_BASE } from '@/lib/api';

export default function ShortlinkClone() {
  const [url, setUrl] = useState('https://example.com/openbuild');
  const [alias, setAlias] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const [created, setCreated] = useState<boolean | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function shorten() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.shorten(url, alias.trim() || undefined);
      setCode(res.code);
      setCreated(res.created);
      setMsg(res.created ? 'Created new short code.' : 'Resolved to existing code (deduped).');
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const shortUrl = code ? `${API_BASE}/${code}` : null;

  return (
    <main>
      <p>
        <a href="/">← Gallery</a>
      </p>
      <header className="masthead">
        <h1>
          Shortlink <span className="pill">correct under load</span>
        </h1>
        <p>
          Shorten a URL to a random, non-enumerable code. Identical URLs (and concurrent races)
          always resolve to the same code — never a 5xx.
        </p>
      </header>

      <section style={{ marginTop: 24 }}>
        <label className="muted">URL</label>
        <input
          className="input"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          style={{ margin: '6px 0 14px' }}
        />
        <label className="muted">Optional alias</label>
        <input
          className="input"
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          placeholder="my-link"
          style={{ margin: '6px 0 14px' }}
        />
        <button className="btn" onClick={shorten} disabled={busy}>
          {busy ? 'Shortening…' : 'Shorten'}
        </button>
      </section>

      {code && (
        <section style={{ marginTop: 24 }}>
          <h3>Code: {code}</h3>
          <p className="muted">
            {created === false ? 'Existing (deduped). ' : 'Fresh. '}
            Visit{' '}
            <a href={shortUrl!} target="_blank" rel="noreferrer">
              {shortUrl}
            </a>{' '}
            to redirect.
          </p>
        </section>
      )}

      {msg && (
        <p className="muted" style={{ marginTop: 16 }}>
          {msg}
        </p>
      )}
    </main>
  );
}
