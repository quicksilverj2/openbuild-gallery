// Thin client for the OpenBuild Gallery API. Base URL is inlined at build time
// from NEXT_PUBLIC_API_URL (falls back to the local api on :3000).
export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

export type Clone = {
  slug: string;
  title: string;
  summary: string;
  demoPath: string;
};

export type PollOption = { id: string; text: string; votes?: number };
export type Tally = { total: number; options: Required<PollOption>[] };
export type Poll = { id: string; question: string; options?: PollOption[]; tally?: Tally };

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    cache: 'no-store',
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(json?.error ?? `request failed (${res.status})`);
  }
  return json as T;
}

export const api = {
  clones: () => req<{ clones: Clone[] }>('/clones'),
  createPoll: (slug: string, question: string, options: string[]) =>
    req<Poll>(`/clones/${slug}/polls`, {
      method: 'POST',
      body: JSON.stringify({ question, options }),
    }),
  getPoll: (id: string) => req<Poll>(`/polls/${id}`),
  vote: (pollId: string, optionId: string, voterId: string, idempotencyKey: string) =>
    req<{ status: string; tally: Tally }>(`/polls/${pollId}/votes`, {
      method: 'POST',
      body: JSON.stringify({ optionId, voterId, idempotencyKey }),
    }),
};
