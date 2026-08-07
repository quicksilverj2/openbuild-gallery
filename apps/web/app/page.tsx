'use client';

import { useEffect, useState } from 'react';
import { api, type Clone } from '@/lib/api';

const LAST_VISIT_KEY = 'obg-last-visit';

function isNew(clone: Clone, lastVisit: number): boolean {
  return new Date(clone.createdAt).getTime() > lastVisit;
}

function authorDisplay(name: string): string {
  if (!name || name === 'seed') return 'OpenBuild';
  if (name.startsWith('@')) return name;
  return `@${name}`;
}

export default function Home() {
  const [clones, setClones] = useState<Clone[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastVisit, setLastVisit] = useState<number>(Date.now());

  useEffect(() => {
    const stored = typeof window !== 'undefined' ? localStorage.getItem(LAST_VISIT_KEY) : null;
    const prev = stored ? parseInt(stored, 10) : 0;
    setLastVisit(prev);

    api
      .clones()
      .then((r) => setClones(r.clones))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));

    return () => {
      if (typeof window !== 'undefined') {
        localStorage.setItem(LAST_VISIT_KEY, Date.now().toString());
      }
    };
  }, []);

  const newCount = clones.filter((c) => isNew(c, lastVisit)).length;

  return (
    <main>
      <header className="masthead">
        <h1>OpenBuild Gallery</h1>
        <p>
          A growing collection of tiny working app-clones. Pick a feature, ship a PR, get merged.
        </p>
        {newCount > 0 && (
          <p className="new-badge-summary">
            {newCount} new {newCount === 1 ? 'clone' : 'clones'} since your last visit
          </p>
        )}
      </header>

      <section style={{ marginTop: 28 }}>
        {loading && <p className="muted">Loading clones…</p>}
        {error && (
          <p className="muted">
            Couldn't reach the API ({error}). Check that it's running and that{' '}
            <code>NEXT_PUBLIC_API_URL</code> points at it.
          </p>
        )}
        {clones.map((c) => {
          const fresh = isNew(c, lastVisit);
          return (
            <a key={c.slug} className="card" href={c.demoPath}>
              <div className="card-header">
                <h3>{c.title}</h3>
                {fresh && <span className="badge-new">New</span>}
              </div>
              <p>{c.summary}</p>
              <p className="card-author">Built by {authorDisplay(c.createdBy)}</p>
            </a>
          );
        })}
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
