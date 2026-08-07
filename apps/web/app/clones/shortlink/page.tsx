'use client';

import { useState } from 'react';
import { api, type Shortlink as ShortlinkType } from '@/lib/api';

export default function ShortlinkClone() {
  const [url, setUrl] = useState('');
  const [alias, setAlias] = useState('');
  const [link, setLink] = useState<ShortlinkType | null>(null);
  const [readCode, setReadCode] = useState('');
  const [redirectUrl, setRedirectUrl] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function shorten() {
    setBusy(true);
    setMsg(null);
    setLink(null);
    try {
      const res = await api.shorten('shortlink', url, alias || undefined);
      setLink(res);
      setMsg(`Shortlink created: /s/${res.code}`);
    } catch (e) {
      const m = (e as Error).message;
      setMsg(m === 'alias_taken' ? 'Alias already taken by another URL.' : m);
    } finally {
      setBusy(false);
    }
  }

  async function resolve() {
    setBusy(true);
    setMsg(null);
    setRedirectUrl(null);
    try {
      const res = await api.resolveShortlink(readCode);
      setRedirectUrl(res.url);
      setMsg(`Redirects to: ${res.url}`);
    } catch (e) {
      setMsg((e as Error).message);
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
          Shortlink <span className="pill">dedup + non-enumerable</span>
        </h1>
        <p>Shorten a URL. Identical URLs dedupe to one code. Codes are crypto-random.</p>
      </header>

      <section style={{ marginTop: 24 }}>
        <label className="muted">URL to shorten</label>
        <input
          className="input"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          style={{ margin: '6px 0 14px' }}
          placeholder="https://example.com/long-url-here"
        />
        <label className="muted">Custom alias (optional)</label>
        <input
          className="input"
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          style={{ margin: '6px 0 14px' }}
          placeholder="my-link"
        />
        <button className="btn" onClick={shorten} disabled={busy || !url}>
          {busy ? 'Shortening...' : 'Shorten'}
        </button>
      </section>

      {link && (
        <section style={{ marginTop: 20 }}>
          <div className="card">
            <h3>Shortlink Created</h3>
            <p>
              <strong>Code:</strong> <code>{link.code}</code>
            </p>
            {link.alias && (
              <p>
                <strong>Alias:</strong> <code>{link.alias}</code>
              </p>
            )}
            <p>
              <strong>URL:</strong> {link.url}
            </p>
          </div>
        </section>
      )}

      <section style={{ marginTop: 28 }}>
        <h3>Resolve a shortlink</h3>
        <label className="muted">Code or alias</label>
        <input
          className="input"
          value={readCode}
          onChange={(e) => setReadCode(e.target.value)}
          style={{ margin: '6px 0 14px' }}
          placeholder="Enter code or alias..."
        />
        <button className="btn" onClick={resolve} disabled={busy || !readCode}>
          {busy ? 'Resolving...' : 'Resolve'}
        </button>

        {redirectUrl && (
          <div className="card" style={{ marginTop: 14 }}>
            <h3>Redirects To</h3>
            <p>
              <a href={redirectUrl} target="_blank" rel="noopener noreferrer">
                {redirectUrl}
              </a>
            </p>
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
