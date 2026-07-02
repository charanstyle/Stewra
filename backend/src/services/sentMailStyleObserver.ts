import type { ProcessDimension, ProcessTier } from '@stewra/shared-types';

/**
 * The Sutton "experiential" core, kept PURE and deterministic (memory-and-learning.md §3): it turns a
 * MINIMIZED view of the user's own Sent mail into candidate style rules. Nothing here reads the
 * network or a DB — the orchestration that fetches Sent mail (behind the user's opt-in) lives in the
 * control plane and calls these functions.
 *
 * The privacy boundary is enforced by the shape of `SentMailSample`: a raw email prefix (`snippet`)
 * only ever enters `classifySentMessage`, which reduces it to a salutation ENUM + a warmth flag + a
 * recipient COUNT and throws the text away. Only those minimized features flow onward — never the
 * subject, body, or any recipient identity — so no email content is ever persisted or modelled.
 */

/** The opener a Sent email uses, classified from its snippet. `none` = no recognizable greeting. */
export type SalutationKind = 'hi' | 'hey' | 'hello' | 'dear' | 'greetings' | 'none';

/** A coarse length band for one email, derived from its snippet — never the raw character count. */
export type LengthBucket = 'short' | 'medium' | 'long';

/** The coarse time-of-day an email was SENT, reduced from its Date header (the sender's local hour). */
export type HourBucket = 'morning' | 'afternoon' | 'evening' | 'night';

/** One Sent email reduced to style features only — no subject, body, or recipient identity. */
export interface SentMailSample {
  readonly salutation: SalutationKind;
  /** A warm/informal marker was present near the opening (exclamation, "hope you", "thanks", …). */
  readonly warmOpen: boolean;
  /** An emoji appeared in the opening — an informal-register signal, kept distinct from `warmOpen`. */
  readonly emojiOpen: boolean;
  /** How many addresses were CC'd (a count only — never who). */
  readonly ccCount: number;
  /** A coarse length band (short/medium/long) from the snippet — a proxy, not the exact length. */
  readonly lengthBucket: LengthBucket;
  /** The sender's local time-of-day the email was sent, or null when the Date header is unreadable. */
  readonly hourBucket: HourBucket | null;
}

/**
 * The single most-frequently-CC'd contact across the sample, MINIMIZED for role resolution: a count
 * and whether that contact shares the user's own email domain. The concrete address is NEVER carried
 * here — it stays in the control plane (to vault) and never reaches this pure module or a rule's text.
 */
export interface RecurringCcContact {
  /** How many sampled emails CC'd this exact contact. */
  readonly count: number;
  /** True when the contact is on the user's OWN email domain (an internal colleague vs an outsider). */
  readonly sameDomain: boolean;
}

/** A style rule the observer proposes, with the evidence backing it. Always lands as `proposed`. */
export interface SentMailRuleCandidate {
  readonly dimension: ProcessDimension;
  readonly rule: string;
  readonly tier: ProcessTier;
  readonly subjectRole: string | null;
  /**
   * True ONLY for an `identifying` recipient rule: the caller must vault the concrete recurring
   * contact and store the resulting handle as `subject_vault_ref`. Never true for a `style`/
   * `relational` rule, which carry no concrete identity.
   */
  readonly needsVault: boolean;
  /** How many sampled emails back this rule. */
  readonly supportCount: number;
  /** 0..100 — the share of the sample exhibiting the pattern. */
  readonly confidence: number;
}

/** Thresholds a pattern must clear to become a proposal: min backing emails and min share of sample. */
export interface ObserverThresholds {
  readonly minSupport: number;
  readonly minShare: number;
}

/** Leading-greeting patterns, tried in order; the first to match the snippet's start wins. */
const SALUTATION_PATTERNS: ReadonlyArray<{ kind: SalutationKind; re: RegExp }> = [
  { kind: 'hi', re: /^\s*hi\b/i },
  { kind: 'hey', re: /^\s*hey\b/i },
  { kind: 'hello', re: /^\s*hello\b/i },
  { kind: 'dear', re: /^\s*dear\b/i },
  { kind: 'greetings', re: /^\s*(greetings|good\s+(morning|afternoon|evening))\b/i },
];

/** Warmth markers near the opening. Deliberately small + high-precision (a false "warm" is worse). */
const WARM_MARKERS: ReadonlyArray<RegExp> = [
  /!/,
  /\bhope you\b/i,
  /\bhope this\b/i,
  /\bthanks so much\b/i,
  /\bthank you so much\b/i,
  /\bgreat to (hear|see|meet)\b/i,
  /\blovely to\b/i,
];

/** Canonical, human phrasing for each recognizable opener (never echoes the user's actual text). */
const SALUTATION_RULE: Record<Exclude<SalutationKind, 'none'>, string> = {
  hi: 'You usually open emails with “Hi”.',
  hey: 'You usually open emails with “Hey” — casual and familiar.',
  hello: 'You usually open emails with “Hello”.',
  dear: 'You usually open emails with “Dear” — a more formal register.',
  greetings: 'You usually open with a time-of-day greeting (e.g. “Good morning”).',
};

/** Canonical phrasing for a recipient (CC) habit. Never names or hints at any concrete contact. */
const RECIPIENT_GENERIC_RULE = 'You often CC an additional person on emails.';
const RECIPIENT_INTERNAL_RULE = 'You habitually CC a colleague on your own team.';
const RECIPIENT_EXTERNAL_RULE = 'You habitually CC a specific external contact.';

/** Canonical phrasing for each length band the observer will surface (medium is never proposed). */
const LENGTH_RULE: Record<Exclude<LengthBucket, 'medium'>, string> = {
  short: 'You keep emails short and to the point.',
  long: 'You tend to write longer, detailed emails.',
};

/** Canonical phrasing for each send-time habit. Never states an exact time — only the coarse band. */
const TIMING_RULE: Record<HourBucket, string> = {
  morning: 'You usually send email in the morning.',
  afternoon: 'You usually send email in the afternoon.',
  evening: 'You usually send email in the evening.',
  night: 'You often send email late at night.',
};

/** How far into the snippet the warmth scan looks — the opening, not the whole (bounded) prefix. */
const WARM_SCAN_CHARS = 60;

/**
 * Snippet-length band edges (characters). The snippet is Gmail's bounded body PREFIX, so this is a
 * coarse proxy for how much the user writes up front — deliberately conservative: `medium` is the
 * grey zone the observer never proposes on. Not user-facing config; classifier constants like
 * `WARM_SCAN_CHARS`.
 */
const SHORT_SNIPPET_CHARS = 80;
const LONG_SNIPPET_CHARS = 160;

/** Any emoji (an Extended_Pictographic code point) — the informal-register marker for `emojiOpen`. */
const EMOJI_RE = /\p{Extended_Pictographic}/u;

/** Band a snippet's trimmed length into short/medium/long. Pure; the raw length never leaves here. */
function lengthBucketOf(snippet: string): LengthBucket {
  const len = snippet.trim().length;
  if (len <= SHORT_SNIPPET_CHARS) {
    return 'short';
  }
  if (len >= LONG_SNIPPET_CHARS) {
    return 'long';
  }
  return 'medium';
}

/**
 * Reduce an RFC-2822 `Date` header to the sender's local time-of-day band. The header's time field is
 * already the sender's WALL-CLOCK time (the trailing offset merely names its zone), so the leading
 * `HH:MM` token is taken as-is — no timezone conversion, which would wrongly re-anchor it to the
 * server's zone. Returns null when no time token is present. Pure and exported for unit testing.
 */
export function hourBucketFromHeader(dateHeader: string): HourBucket | null {
  const match = /(\d{1,2}):(\d{2})/.exec(dateHeader);
  if (!match) {
    return null;
  }
  const hour = Number(match[1]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    return null;
  }
  if (hour >= 5 && hour <= 11) {
    return 'morning';
  }
  if (hour >= 12 && hour <= 16) {
    return 'afternoon';
  }
  if (hour >= 17 && hour <= 21) {
    return 'evening';
  }
  return 'night';
}

/**
 * Reduce one Sent email — given only a bounded body prefix (`snippet`) and a CC count — to its
 * minimized style features. The snippet is read HERE and thrown away by the caller; only the returned
 * `SentMailSample` (enum + flag + count) leaves this boundary. Pure, so it is unit-testable and can
 * never accidentally retain content.
 */
export function classifySentMessage(input: {
  snippet: string;
  ccCount: number;
  /** The raw `Date` header, reduced HERE to an `hourBucket` and discarded — never carried onward. */
  dateHeader?: string;
}): SentMailSample {
  const snippet = input.snippet ?? '';
  const opener = snippet.slice(0, WARM_SCAN_CHARS);

  let salutation: SalutationKind = 'none';
  for (const { kind, re } of SALUTATION_PATTERNS) {
    if (re.test(snippet)) {
      salutation = kind;
      break;
    }
  }

  const warmOpen = WARM_MARKERS.some((re) => re.test(opener));
  const emojiOpen = EMOJI_RE.test(opener);
  const ccCount = Number.isFinite(input.ccCount) && input.ccCount > 0 ? Math.trunc(input.ccCount) : 0;
  const lengthBucket = lengthBucketOf(snippet);
  const hourBucket = input.dateHeader ? hourBucketFromHeader(input.dateHeader) : null;

  return { salutation, warmOpen, emojiOpen, ccCount, lengthBucket, hourBucket };
}

/** True when `count` out of `total` clears both the absolute (`minSupport`) and relative (`minShare`) bars. */
function meetsThreshold(count: number, total: number, thresholds: ObserverThresholds): boolean {
  if (total <= 0 || count < thresholds.minSupport) {
    return false;
  }
  return count / total >= thresholds.minShare;
}

/** Confidence = the pattern's share of the sample, as a bounded 0..100 integer. */
function shareConfidence(count: number, total: number): number {
  return Math.min(100, Math.max(0, Math.round((count / total) * 100)));
}

/**
 * Aggregate minimized Sent-mail samples into candidate style rules. A pattern becomes a candidate
 * ONLY when it dominates the whole sample (clears `minSupport` AND `minShare`), keeping proposals
 * high-precision. Returns an empty list when nothing is confident enough — the observer stays quiet
 * rather than guessing (§3). Everything it emits is a PROPOSAL for the user to confirm; nothing here
 * activates a rule.
 *
 * Recipient (CC) handling resolves a recurring contact to a ROLE when the evidence allows and falls
 * back to a vaulted identity otherwise (see `resolveRecipientRule`): a same-domain contact becomes a
 * `relational` colleague rule (no identity stored); an external contact becomes an `identifying` rule
 * the caller must back with a vaulted handle; with no recurring contact it stays a generic `style`
 * habit. `recurringCc` is the minimized cross-sample signal (count + same-domain flag) — the concrete
 * address is never passed here.
 */
export function observeSentMailStyle(
  samples: ReadonlyArray<SentMailSample>,
  thresholds: ObserverThresholds,
  recurringCc: RecurringCcContact | null = null,
): SentMailRuleCandidate[] {
  const total = samples.length;
  const candidates: SentMailRuleCandidate[] = [];
  if (total === 0) {
    return candidates;
  }

  // Salutation: the single most common recognizable opener, if it dominates the whole sample.
  const salutationCounts = new Map<Exclude<SalutationKind, 'none'>, number>();
  for (const s of samples) {
    if (s.salutation !== 'none') {
      salutationCounts.set(s.salutation, (salutationCounts.get(s.salutation) ?? 0) + 1);
    }
  }
  let topSalutation: Exclude<SalutationKind, 'none'> | null = null;
  let topSalutationCount = 0;
  for (const [kind, count] of salutationCounts) {
    if (count > topSalutationCount) {
      topSalutation = kind;
      topSalutationCount = count;
    }
  }
  if (topSalutation && meetsThreshold(topSalutationCount, total, thresholds)) {
    candidates.push({
      dimension: 'salutation',
      rule: SALUTATION_RULE[topSalutation],
      tier: 'style',
      subjectRole: null,
      needsVault: false,
      supportCount: topSalutationCount,
      confidence: shareConfidence(topSalutationCount, total),
    });
  }

  // Tone: a warm/informal opening as the dominant register. Emoji is a facet of the SAME tone axis —
  // folded in here (never a second `tone` candidate) so it can't collide on the (domain, tone) axis
  // that `capture` upserts on: if warmth dominates, an also-dominant emoji habit just enriches the
  // phrasing; if only emoji dominates, it stands alone as the tone signal.
  const warmCount = samples.filter((s) => s.warmOpen).length;
  const emojiCount = samples.filter((s) => s.emojiOpen).length;
  if (meetsThreshold(warmCount, total, thresholds)) {
    const alsoEmoji = meetsThreshold(emojiCount, total, thresholds);
    candidates.push({
      dimension: 'tone',
      rule: alsoEmoji
        ? 'Your emails tend to open warm and friendly, often with emoji.'
        : 'Your emails tend to open warm and friendly.',
      tier: 'style',
      subjectRole: null,
      needsVault: false,
      supportCount: warmCount,
      confidence: shareConfidence(warmCount, total),
    });
  } else if (meetsThreshold(emojiCount, total, thresholds)) {
    candidates.push({
      dimension: 'tone',
      rule: 'You often use emoji in your emails.',
      tier: 'style',
      subjectRole: null,
      needsVault: false,
      supportCount: emojiCount,
      confidence: shareConfidence(emojiCount, total),
    });
  }

  // Length: only the decisive ends (short/long) — a "medium" habit isn't actionable, so it stays
  // quiet. `meetsThreshold` needs a >= minShare majority, so short and long can't both qualify.
  const lengthCounts: Record<LengthBucket, number> = { short: 0, medium: 0, long: 0 };
  for (const s of samples) {
    lengthCounts[s.lengthBucket] += 1;
  }
  for (const band of ['short', 'long'] as const) {
    if (meetsThreshold(lengthCounts[band], total, thresholds)) {
      candidates.push({
        dimension: 'length',
        rule: LENGTH_RULE[band],
        tier: 'style',
        subjectRole: null,
        needsVault: false,
        supportCount: lengthCounts[band],
        confidence: shareConfidence(lengthCounts[band], total),
      });
    }
  }

  // Timing: the send-time band that dominates the whole sample. Emails whose Date header didn't
  // parse (null bucket) count toward `total` but no band — they can only dilute, never mislead.
  const timingCounts = new Map<HourBucket, number>();
  for (const s of samples) {
    if (s.hourBucket) {
      timingCounts.set(s.hourBucket, (timingCounts.get(s.hourBucket) ?? 0) + 1);
    }
  }
  let topBucket: HourBucket | null = null;
  let topBucketCount = 0;
  for (const [bucket, count] of timingCounts) {
    if (count > topBucketCount) {
      topBucket = bucket;
      topBucketCount = count;
    }
  }
  if (topBucket && meetsThreshold(topBucketCount, total, thresholds)) {
    candidates.push({
      dimension: 'timing',
      rule: TIMING_RULE[topBucket],
      tier: 'style',
      subjectRole: null,
      needsVault: false,
      supportCount: topBucketCount,
      confidence: shareConfidence(topBucketCount, total),
    });
  }

  // Recipients: prefer a specific recurring contact (role-abstracted or vault-bound) over the generic
  // "you CC someone" habit — the identity-aware resolution the plan calls for.
  const recipientRule = resolveRecipientRule(samples, recurringCc, thresholds);
  if (recipientRule) {
    candidates.push(recipientRule);
  }

  return candidates;
}

/**
 * Resolve the recipient (CC) habit into a single candidate, honouring the plan's role-abstraction +
 * vault-fallback rule:
 *  - a recurring same-domain contact → a `relational` rule about an `internal_colleague` (a ROLE, no
 *    identity ever stored);
 *  - a recurring external contact → an `identifying` rule the caller must back with a vaulted handle
 *    (`needsVault`), because the role can't be inferred and we don't guess ("default to the vault");
 *  - no recurring contact but a broad habit of CC'ing SOMEONE → a generic `style` rule.
 * Returns null when nothing clears the thresholds. Never places any address in the rule text.
 */
function resolveRecipientRule(
  samples: ReadonlyArray<SentMailSample>,
  recurringCc: RecurringCcContact | null,
  thresholds: ObserverThresholds,
): SentMailRuleCandidate | null {
  const total = samples.length;

  if (recurringCc && meetsThreshold(recurringCc.count, total, thresholds)) {
    const confidence = shareConfidence(recurringCc.count, total);
    return recurringCc.sameDomain
      ? {
          dimension: 'recipients',
          rule: RECIPIENT_INTERNAL_RULE,
          tier: 'relational',
          subjectRole: 'internal_colleague',
          needsVault: false,
          supportCount: recurringCc.count,
          confidence,
        }
      : {
          dimension: 'recipients',
          rule: RECIPIENT_EXTERNAL_RULE,
          tier: 'identifying',
          subjectRole: null,
          needsVault: true,
          supportCount: recurringCc.count,
          confidence,
        };
  }

  const ccCount = samples.filter((s) => s.ccCount > 0).length;
  if (meetsThreshold(ccCount, total, thresholds)) {
    return {
      dimension: 'recipients',
      rule: RECIPIENT_GENERIC_RULE,
      tier: 'style',
      subjectRole: null,
      needsVault: false,
      supportCount: ccCount,
      confidence: shareConfidence(ccCount, total),
    };
  }

  return null;
}
