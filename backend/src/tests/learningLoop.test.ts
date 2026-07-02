import { RATING_REWARD, POSITIVE_RATINGS, RATINGS } from '@stewra/shared-types';
import { buildMemoryLabel } from '../utils/memoryLabel';
import { normalizeText, keywords } from '../utils/text';

/**
 * Pure unit tests for the feedback + learning loop's deterministic core — the reward signal, the
 * searchable memory label, and the shared normalization that makes "same/similar task" matching
 * predictable. No DB, no network.
 */

describe('RATING_REWARD (the scalar reward signal)', () => {
  it('maps every rating and orders reward monotonically worst→best', () => {
    // Every rating has a reward, and they strictly increase from poor to outstanding — the ordering
    // the recall step relies on when it ranks exemplars by reward.
    const rewards = RATINGS.map((r) => RATING_REWARD[r]);
    for (let i = 1; i < rewards.length; i += 1) {
      expect(rewards[i]).toBeGreaterThan(rewards[i - 1] as number);
    }
  });

  it('makes negative-vs-positive split align with POSITIVE_RATINGS', () => {
    for (const rating of RATINGS) {
      const isPositive = POSITIVE_RATINGS.includes(rating);
      expect(RATING_REWARD[rating] > 0).toBe(isPositive);
    }
  });
});

describe('buildMemoryLabel (the searchable NAME)', () => {
  it('scopes by kind, distills a keyword phrase, and shows the rating', () => {
    const label = buildMemoryLabel('calendar', 'Prep for my weekly 1:1 with Sam', 'outstanding');
    // Order-preserved keywords (prep, weekly, 1, sam); "for"/"my"/"with" dropped, duplicate "1" collapsed.
    expect(label).toBe('Calendar · Prep weekly 1 sam (outstanding)');
  });

  it('drops stopwords and de-dupes so the name stays scannable', () => {
    const label = buildMemoryLabel('gmail', 'the the invoice and the invoice from Acme', 'good');
    // "the"/"and"/"from" dropped, duplicate "invoice" collapsed.
    expect(label).toBe('Gmail · Invoice acme (good)');
  });

  it('falls back to "General" when the purpose has no searchable terms', () => {
    expect(buildMemoryLabel('money', 'the and of', 'excellent')).toBe('Money · General (excellent)');
  });

  it('caps overly long labels to the max length', () => {
    const longPurpose = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ');
    const label = buildMemoryLabel('calendar', longPurpose, 'good');
    expect(label.length).toBeLessThanOrEqual(200);
  });
});

describe('normalizeText / keywords (shared store+search normalization)', () => {
  it('normalizes identically regardless of case and punctuation', () => {
    expect(normalizeText('Weekly 1:1 with Sam!!')).toBe('weekly 1 1 with sam');
    expect(normalizeText('  WEEKLY   1:1   with   SAM  ')).toBe('weekly 1 1 with sam');
  });

  it('extracts distinct, order-preserving, non-stopword tokens', () => {
    expect(keywords('Prep for the weekly weekly review with Sam')).toEqual([
      'prep',
      'weekly',
      'review',
      'sam',
    ]);
  });

  it('returns no keywords for a stopword-only string (so recall stays empty, never errors)', () => {
    expect(keywords('the and of to')).toEqual([]);
  });
});
