'use client';

import { useEffect, useState } from 'react';
import { api, type Clone } from '@/lib/api';

export default function Home() {
  const [clones, setClones] = useState<Clone[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .clones()
      .then((r) => setClones(r.clones))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

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
            Couldn’t reach the API ({error}). Check that it’s running and that{' '}
            <code>NEXT_PUBLIC_API_URL</code> points at it.
          </p>
        )}
        {clones.map((c) => (
          <a key={c.slug} className="card" href={c.demoPath}>
            <h3>{c.title}</h3>
            <p>{c.summary}</p>
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
