import { describe, expect, it } from 'vitest';
import { RecentMessages } from '../core/recentMessages.js';

describe('RecentMessages', () => {
  it('returns what it was given, and null for an id it never saw', () => {
    const recent = new RecentMessages<string>(3);
    recent.remember('a', 'A');
    expect(recent.get('a')).toBe('A');
    expect(recent.get('zzz')).toBeNull();
  });

  it('forgets the oldest once full — the newest N are always the ones kept', () => {
    const recent = new RecentMessages<string>(2);
    recent.remember('a', 'A');
    recent.remember('b', 'B');
    recent.remember('c', 'C');
    expect(recent.get('a')).toBeNull();
    expect(recent.get('b')).toBe('B');
    expect(recent.get('c')).toBe('C');
    expect(recent.size).toBe(2);
  });

  it('treats a re-seen id as newest rather than as a duplicate', () => {
    const recent = new RecentMessages<string>(2);
    recent.remember('a', 'A');
    recent.remember('b', 'B');
    recent.remember('a', 'A2');
    recent.remember('c', 'C');
    // `b` was the oldest untouched entry, so it is the one that went.
    expect(recent.get('b')).toBeNull();
    expect(recent.get('a')).toBe('A2');
    expect(recent.size).toBe(2);
  });

  it('refuses a capacity that could never hold a message', () => {
    expect(() => new RecentMessages<string>(0)).toThrow(/positive integer/);
  });
});
