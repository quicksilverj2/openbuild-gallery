'use client';

import { useEffect, useMemo, useState } from 'react';
import { api, type Clone } from '@/lib/api';

const LS_KEY = 'openbuild-gallery-last-visit';

export default function Home() {
  const [clones, setClones] = useState<Clone[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Track which clones are new since the viewer's last visit.
  const [lastVisit, setLastVisit] = useState<string | null>(null);

  useEffect(() => {
    // Read persisted last-visit timestamp before fetching.
    if (typeof window !== 'undefined') {
      setLastVisit(localStorage.getItem(LS_KEY));
    }
  }, []);

  useEffect(() => {
    api
      .clones()
      .then((r) => setClones(r.clones))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  // Persist the current time as the new last-visit after clones load.
  useEffect(() => {
    if (loading) return;
    if (typeof window !== 'undefined') {
      localStorage.setItem(LS_KEY, new Date().toISOString());
    }
  }, [loading]);

  // Memoize which clones are new to avoid re-render flicker.
  const newSlugs = useMemo(() => {
    if (!lastVisit) return new Set<string>();
    return new Set(
      clones
        .filter((c) => c.createdAt && c.createdAt > lastVisit)
        .map((c) => c.slug),
    );
  }, [clones, lastVisit]);

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
            Couldn&apos;t reach the API ({error}). Check that it&apos;s running and that{' '}
            <code>NEXT_PUBLIC_API_URL</code> points at it.
          </p>
        )}
        {clones.map((c) => {
          const isNew = newSlugs.has(c.slug);
          return (
            <a key={c.slug} className="card" href={c.demoPath}>
              <div className="card-header">
                <h3>{c.title}</h3>
                {isNew && <span className="pill new-badge">NEW</span>}
              </div>
              <p>{c.summary}</p>
              {c.createdBy && c.createdBy !== 'seed' && (
                <p className="card-author">
                  Built by <span className="author-name">{c.createdBy}</span>
                </p>
              )}
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
