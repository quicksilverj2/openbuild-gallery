'use client';

import { useEffect, useState } from 'react';
import { api, type Clone } from '@/lib/api';

const LAST_VISIT_KEY = 'obg-last-visit';

function getLastVisit(): number {
  if (typeof window === 'undefined') return 0;
  const v = window.localStorage.getItem(LAST_VISIT_KEY);
  return v ? parseInt(v, 10) : 0;
}

function setLastVisit(ts: number) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(LAST_VISIT_KEY, String(ts));
}

export default function Home() {
  const [clones, setClones] = useState<Clone[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastVisit, setLastVisitState] = useState(0);

  useEffect(() => {
    const ts = getLastVisit();
    setLastVisitState(ts);
    setLastVisit(Date.now());
    api
      .clones()
      .then((r) => setClones(r.clones))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  function isNew(clone: Clone): boolean {
    return new Date(clone.createdAt).getTime() > lastVisit;
  }

  return (
    <main>
      <header className="masthead">
        <h1>OpenBuild Gallery</h1>
        <p>
          A growing collection of tiny working app-clones. Pick a feature, ship a PR, get merged.
        </p>
      </header>

      <section style={{ marginTop: 28 }}>
        {loading && <p className="muted">Loading clones…</p>}
        {error && (
          <p className="muted">
            Couldn't reach the API ({error}). Check that it's running and that{' '}
            <code>NEXT_PUBLIC_API_URL</code> points at it.
          </p>
        )}
        {clones.map((c) => (
          <a key={c.slug} className="card" href={c.demoPath}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
              <div>
                <h3>{c.title}</h3>
                <p>{c.summary}</p>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                <span className="muted" style={{ fontSize: 12 }}>
                  by {c.createdBy}
                </span>
                {isNew(c) && (
                  <span
                    className="pill"
                    style={{ fontSize: 11, padding: '2px 6px', background: '#1a3a1a', color: '#4ade80' }}
                  >
                    New
                  </span>
                )}
              </div>
            </div>
          </a>
        ))}
        {!loading && !error && clones.length === 0 && (
          <p className="muted">No clones yet. Seed the API to add the Poll clone.</p>
        )}
      </section>

      <footer style={{ marginTop: 40 }}>
        <p className="muted">
          Want to contribute? Read CONTRIBUTING.md, pick a bounty, open a PR — the strongest
          implementation gets merged to production and credited.
        </p>
      </footer>
    </main>
  );
}