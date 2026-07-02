import type { ProcessRuleStatus } from '@stewra/shared-types';
import { RATING_REWARD } from '@stewra/shared-types';
import { isSilentClobber, reinforcementDeltas } from '../services/processMemoryService';
import { extractProcessRuleCandidates } from '../utils/processRuleExtraction';
import {
  classifySentMessage,
  hourBucketFromHeader,
  observeSentMailStyle,
  type SentMailSample,
} from '../services/sentMailStyleObserver';

/**
 * Pure unit test for the process/style store's governing invariant (memory-and-learning.md §3): a
 * machine-`proposed` candidate must NEVER silently overwrite a rule the user has already confirmed
 * (`active`). Every other axis transition is permitted. No DB, no network — the decision is pure.
 */

const STATUSES: ReadonlyArray<ProcessRuleStatus> = ['proposed', 'active', 'muted'];

describe('isSilentClobber (§3 — the model never overwrites a confirmed rule silently)', () => {
  it('blocks ONLY a proposal landing on an already-active rule', () => {
    for (const existing of STATUSES) {
      for (const incoming of STATUSES) {
        const expected = existing === 'active' && incoming === 'proposed';
        expect(isSilentClobber(existing, incoming)).toBe(expected);
      }
    }
  });

  it('allows a user confirming (proposed→active) and refreshing an active rule (active→active)', () => {
    expect(isSilentClobber('proposed', 'active')).toBe(false);
    expect(isSilentClobber('active', 'active')).toBe(false);
  });

  it('allows a fresh proposal on a muted or proposed axis (nothing confirmed to protect)', () => {
    expect(isSilentClobber('muted', 'proposed')).toBe(false);
    expect(isSilentClobber('proposed', 'proposed')).toBe(false);
  });
});

/**
 * The Sutton reward step, as a pure decision (memory-and-learning.md §6): a rated insight reinforces
 * the rules that shaped it (confidence up, one more supporting observation) or decays them on a poor
 * rating (confidence down, no new support). Reward always accrues the raw signed scalar so the running
 * score reflects net outcome. No DB — the movement is pure and unit-testable.
 */
describe('reinforcementDeltas (rated feedback → how the shaping rules move)', () => {
  const STEP = 5;

  it('reinforces on every positive rating: confidence up by the step, support +1, reward signed', () => {
    for (const rating of ['good', 'excellent', 'outstanding'] as const) {
      const reward = RATING_REWARD[rating];
      expect(reinforcementDeltas(reward, STEP)).toEqual({
        rewardDelta: reward,
        confidenceDelta: STEP,
        supportDelta: 1,
      });
    }
  });

  it('decays on every negative rating: confidence down by the step, no new support, reward signed', () => {
    for (const rating of ['poor', 'average'] as const) {
      const reward = RATING_REWARD[rating];
      expect(reinforcementDeltas(reward, STEP)).toEqual({
        rewardDelta: reward,
        confidenceDelta: -STEP,
        supportDelta: 0,
      });
    }
  });
});

describe('extractProcessRuleCandidates (deterministic feedback → rule candidates)', () => {
  it('returns nothing for an empty/whitespace comment or an unknown-domain comment', () => {
    expect(extractProcessRuleCandidates('email', null)).toEqual([]);
    expect(extractProcessRuleCandidates('email', '   ')).toEqual([]);
    // No signals defined for these domains yet → always empty, even with signal words present.
    expect(extractProcessRuleCandidates('calendar', 'please keep it shorter')).toEqual([]);
  });

  it('maps a clear length/tone/cc/proofread signal to its dimension', () => {
    expect(extractProcessRuleCandidates('email', 'this is way too long, be concise')).toEqual([
      { dimension: 'length', rule: 'Keep it concise — short and to the point.' },
    ]);
    expect(extractProcessRuleCandidates('email', 'sounds cold — make it warmer')).toEqual([
      { dimension: 'tone', rule: 'Keep the tone warm and personable.' },
    ]);
    expect(extractProcessRuleCandidates('email', 'remember to cc my manager')).toEqual([
      { dimension: 'recipients', rule: 'Consider who to CC based on the thread.' },
    ]);
    expect(extractProcessRuleCandidates('email', 'you had a typo — proofread it')).toEqual([
      { dimension: 'proofreading', rule: 'Proofread carefully before sending.' },
    ]);
  });

  it('emits at most one candidate per dimension, in signal-table order', () => {
    const out = extractProcessRuleCandidates('email', 'too long, add a typo check, and cc the team');
    // length + recipients + proofreading, deduped and ordered as declared (length → recipients → proofread).
    expect(out.map((c) => c.dimension)).toEqual(['length', 'recipients', 'proofreading']);
  });

  it('stays silent when no known style signal is present (no noise)', () => {
    expect(extractProcessRuleCandidates('email', 'thanks, this looks great!')).toEqual([]);
  });
});

/**
 * The experiential core (memory-and-learning.md §3): the Sent-mail observer is a PURE function over
 * minimized samples. It must classify openers correctly, discard raw text, and only propose a rule
 * when a pattern truly dominates the sample — never guess.
 */
describe('classifySentMessage (raw snippet → minimized features, text discarded)', () => {
  it('classifies the leading greeting and never returns the raw snippet', () => {
    const sample = classifySentMessage({ snippet: 'Hi Dana, hope you are well —', ccCount: 2 });
    expect(sample).toEqual({
      salutation: 'hi',
      warmOpen: true,
      emojiOpen: false,
      ccCount: 2,
      lengthBucket: 'short',
      hourBucket: null,
    });
    // The returned object carries only enum/flag/count — no field holds the original text.
    expect(Object.values(sample)).not.toContain('Hi Dana, hope you are well —');
  });

  it('recognizes each opener form and falls back to none', () => {
    expect(classifySentMessage({ snippet: 'Hey team!', ccCount: 0 }).salutation).toBe('hey');
    expect(classifySentMessage({ snippet: 'Hello there,', ccCount: 0 }).salutation).toBe('hello');
    expect(classifySentMessage({ snippet: 'Dear Dr. Lee,', ccCount: 0 }).salutation).toBe('dear');
    expect(classifySentMessage({ snippet: 'Good morning all,', ccCount: 0 }).salutation).toBe(
      'greetings',
    );
    expect(classifySentMessage({ snippet: 'Please see attached.', ccCount: 0 }).salutation).toBe(
      'none',
    );
  });

  it('flags warmth only on a real marker, and treats a negative/absent CC count as zero', () => {
    expect(classifySentMessage({ snippet: 'Dear Sir or Madam,', ccCount: 0 }).warmOpen).toBe(false);
    expect(classifySentMessage({ snippet: 'Hi — thanks so much for this', ccCount: 0 }).warmOpen).toBe(
      true,
    );
    expect(classifySentMessage({ snippet: 'Hi', ccCount: -3 }).ccCount).toBe(0);
  });

  it('bands the snippet length into short/medium/long', () => {
    expect(classifySentMessage({ snippet: 'Sounds good, thanks!', ccCount: 0 }).lengthBucket).toBe(
      'short',
    );
    expect(classifySentMessage({ snippet: 'x'.repeat(120), ccCount: 0 }).lengthBucket).toBe('medium');
    expect(classifySentMessage({ snippet: 'x'.repeat(200), ccCount: 0 }).lengthBucket).toBe('long');
  });

  it('detects an emoji in the opening, distinct from a warmth marker', () => {
    const withEmoji = classifySentMessage({ snippet: 'Hi team 🎉 quick update', ccCount: 0 });
    expect(withEmoji.emojiOpen).toBe(true);
    // A plain-text warm opener is warm but carries no emoji — the two flags are independent.
    const warmNoEmoji = classifySentMessage({ snippet: 'Hi — thanks so much!', ccCount: 0 });
    expect(warmNoEmoji.emojiOpen).toBe(false);
    expect(warmNoEmoji.warmOpen).toBe(true);
  });

  it('reduces the Date header to the sender-local send band, without a null-header crashing', () => {
    // The header time is the sender's wall clock; the leading HH is taken as-is (no TZ re-anchoring).
    expect(classifySentMessage({ snippet: 'Hi', ccCount: 0, dateHeader: 'Wed, 02 Jul 2025 08:15:00 -0700' }).hourBucket).toBe('morning');
    expect(classifySentMessage({ snippet: 'Hi', ccCount: 0 }).hourBucket).toBeNull();
  });
});

describe('hourBucketFromHeader (RFC-2822 Date → coarse send band, sender-local)', () => {
  it('maps each part of the day and ignores the timezone offset', () => {
    expect(hourBucketFromHeader('Wed, 02 Jul 2025 06:00:00 -0700')).toBe('morning');
    expect(hourBucketFromHeader('Wed, 02 Jul 2025 14:30:00 +0000')).toBe('afternoon');
    expect(hourBucketFromHeader('Wed, 02 Jul 2025 19:05:00 +0530')).toBe('evening');
    expect(hourBucketFromHeader('Wed, 02 Jul 2025 23:59:00 -0400')).toBe('night');
    expect(hourBucketFromHeader('Wed, 02 Jul 2025 02:00:00 +0100')).toBe('night');
  });

  it('returns null when there is no readable time token', () => {
    expect(hourBucketFromHeader('not a date')).toBeNull();
    expect(hourBucketFromHeader('')).toBeNull();
  });
});

describe('observeSentMailStyle (only proposes a rule when a pattern dominates the sample)', () => {
  const thresholds = { minSupport: 3, minShare: 0.6 };
  const sample = (over: Partial<SentMailSample>): SentMailSample => ({
    salutation: 'none',
    warmOpen: false,
    emojiOpen: false,
    ccCount: 0,
    lengthBucket: 'medium',
    hourBucket: null,
    ...over,
  });

  it('returns nothing for an empty sample', () => {
    expect(observeSentMailStyle([], thresholds)).toEqual([]);
  });

  it('proposes the dominant salutation with support + confidence', () => {
    const samples = [
      sample({ salutation: 'hi' }),
      sample({ salutation: 'hi' }),
      sample({ salutation: 'hi' }),
      sample({ salutation: 'dear' }),
    ];
    const out = observeSentMailStyle(samples, thresholds);
    const salutationRule = out.find((c) => c.dimension === 'salutation');
    expect(salutationRule).toMatchObject({ tier: 'style', subjectRole: null, supportCount: 3 });
    expect(salutationRule?.confidence).toBe(75); // 3/4
  });

  it('does not propose a salutation that fails minShare even if it clears minSupport', () => {
    // 3 "hi" out of 8 → clears minSupport (3) but only 0.375 share (< 0.6): stays quiet.
    const samples = [
      ...Array.from({ length: 3 }, () => sample({ salutation: 'hi' })),
      ...Array.from({ length: 5 }, () => sample({ salutation: 'none' })),
    ];
    expect(observeSentMailStyle(samples, thresholds).some((c) => c.dimension === 'salutation')).toBe(
      false,
    );
  });

  it('proposes a generic CC habit (no identifiable recurring contact) as plain style', () => {
    const samples = Array.from({ length: 5 }, () => sample({ warmOpen: true, ccCount: 1 }));
    const out = observeSentMailStyle(samples, thresholds);
    expect(out.find((c) => c.dimension === 'tone')).toMatchObject({ tier: 'style', supportCount: 5 });
    // With no recurring contact, the CC habit stays a generic style rule — no role, no vault.
    expect(out.find((c) => c.dimension === 'recipients')).toMatchObject({
      tier: 'style',
      subjectRole: null,
      needsVault: false,
    });
  });

  it('proposes a length rule only for a dominant decisive band, never for medium', () => {
    const short = observeSentMailStyle(
      Array.from({ length: 5 }, () => sample({ lengthBucket: 'short' })),
      thresholds,
    );
    expect(short.find((c) => c.dimension === 'length')).toMatchObject({
      rule: 'You keep emails short and to the point.',
      supportCount: 5,
    });
    // A sample dominated by "medium" is unremarkable — the observer stays quiet on length.
    const medium = observeSentMailStyle(
      Array.from({ length: 5 }, () => sample({ lengthBucket: 'medium' })),
      thresholds,
    );
    expect(medium.some((c) => c.dimension === 'length')).toBe(false);
  });

  it('emits a single tone rule for emoji, and enriches (not duplicates) it when warmth also dominates', () => {
    // Emoji alone → one tone candidate about emoji.
    const emojiOnly = observeSentMailStyle(
      Array.from({ length: 5 }, () => sample({ emojiOpen: true })),
      thresholds,
    );
    const emojiTone = emojiOnly.filter((c) => c.dimension === 'tone');
    expect(emojiTone).toHaveLength(1);
    expect(emojiTone[0]?.rule).toMatch(/emoji/);

    // Warmth + emoji both dominant → still ONE tone candidate (no axis collision), phrasing enriched.
    const both = observeSentMailStyle(
      Array.from({ length: 5 }, () => sample({ warmOpen: true, emojiOpen: true })),
      thresholds,
    );
    const bothTone = both.filter((c) => c.dimension === 'tone');
    expect(bothTone).toHaveLength(1);
    expect(bothTone[0]?.rule).toMatch(/warm.*emoji/);
  });

  it('proposes a timing rule when one send-band dominates, discounting unreadable dates', () => {
    const samples = [
      ...Array.from({ length: 4 }, () => sample({ hourBucket: 'morning' })),
      sample({ hourBucket: null }), // unparseable Date → dilutes but never mis-attributes
    ];
    const out = observeSentMailStyle(samples, thresholds);
    expect(out.find((c) => c.dimension === 'timing')).toMatchObject({
      rule: 'You usually send email in the morning.',
      tier: 'style',
      supportCount: 4,
    });
  });

  it('stays quiet on timing when no single band reaches the majority share', () => {
    const samples = [
      ...Array.from({ length: 2 }, () => sample({ hourBucket: 'morning' })),
      ...Array.from({ length: 2 }, () => sample({ hourBucket: 'evening' })),
      sample({ hourBucket: 'night' }),
    ];
    expect(observeSentMailStyle(samples, thresholds).some((c) => c.dimension === 'timing')).toBe(
      false,
    );
  });
});

/**
 * Phase F — role-resolution + vault fallback (memory-and-learning.md privacy model): a recurring CC'd
 * contact is abstracted to a ROLE when same-domain (no identity stored) or bound to a VAULTED handle
 * when external (role unknowable → don't guess). The concrete address never enters the observer here;
 * only a minimized {count, sameDomain} signal does, and the rule text never names anyone.
 */
describe('observeSentMailStyle recipient resolution (role abstraction + vault fallback)', () => {
  const thresholds = { minSupport: 3, minShare: 0.6 };
  const cc = (ccCount: number): SentMailSample => ({
    salutation: 'none',
    warmOpen: false,
    emojiOpen: false,
    ccCount,
    lengthBucket: 'medium',
    hourBucket: null,
  });

  it('abstracts a recurring same-domain contact to an internal_colleague role, no vault', () => {
    const samples = Array.from({ length: 5 }, () => cc(1));
    const out = observeSentMailStyle(samples, thresholds, { count: 4, sameDomain: true });
    expect(out.find((c) => c.dimension === 'recipients')).toMatchObject({
      tier: 'relational',
      subjectRole: 'internal_colleague',
      needsVault: false,
      supportCount: 4,
    });
  });

  it('binds a recurring external contact to an identifying rule that requires a vaulted handle', () => {
    const samples = Array.from({ length: 5 }, () => cc(1));
    const out = observeSentMailStyle(samples, thresholds, { count: 4, sameDomain: false });
    const recipient = out.find((c) => c.dimension === 'recipients');
    expect(recipient).toMatchObject({ tier: 'identifying', subjectRole: null, needsVault: true });
    // The generalized rule must never hint at a concrete identity — the address lives only in the vault.
    expect(recipient?.rule).not.toMatch(/@/);
  });

  it('falls back to the generic style habit when the recurring contact misses the threshold', () => {
    // The contact recurs only twice (< minSupport 3), but every email still CCs someone → generic.
    const samples = Array.from({ length: 5 }, () => cc(1));
    const out = observeSentMailStyle(samples, thresholds, { count: 2, sameDomain: false });
    expect(out.find((c) => c.dimension === 'recipients')).toMatchObject({
      tier: 'style',
      subjectRole: null,
      needsVault: false,
    });
  });
});
