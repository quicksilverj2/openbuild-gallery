/** Track the set of clone slugs the viewer has seen — extracted for testing. */

const LS_KEY = 'obg-seen-clones';

export function readSeenClones(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

export function markSeen(slug: string) {
  try {
    const s = readSeenClones();
    s.add(slug);
    localStorage.setItem(LS_KEY, JSON.stringify(Array.from(s)));
  } catch {
    /* localStorage unavailable — degrade gracefully */
  }
}

export function isNew(slug: string): boolean {
  return !readSeenClones().has(slug);
}