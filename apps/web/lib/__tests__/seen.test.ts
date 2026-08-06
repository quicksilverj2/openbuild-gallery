import { describe, it, expect, beforeEach } from 'vitest';
import { isNew, markSeen, readSeenClones } from '@/lib/seen';

describe('seen-tracking', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts with no clones seen', () => {
    expect(isNew('poll')).toBe(true);
    expect(isNew('shortlink')).toBe(true);
  });

  it('marks a clone as seen', () => {
    markSeen('poll');
    expect(isNew('poll')).toBe(false);
  });

  it('only marks the specific clone', () => {
    markSeen('poll');
    expect(isNew('poll')).toBe(false);
    expect(isNew('shortlink')).toBe(true);
  });

  it('persists across sessions', () => {
    markSeen('poll');
    markSeen('paste');
    const s = readSeenClones();
    expect(s.has('poll')).toBe(true);
    expect(s.has('paste')).toBe(true);
    expect(s.has('shortlink')).toBe(false);
  });

  it('handles localStorage being unavailable', () => {
    const orig = localStorage.getItem;
    // @ts-ignore
    localStorage.getItem = () => { throw new Error('quota exceeded'); };

    expect(isNew('poll')).toBe(true); // gracefully falls back
    markSeen('poll'); // gracefully handles error

    // @ts-ignore
    localStorage.getItem = orig;
  });
});