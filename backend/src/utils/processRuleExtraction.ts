import type { ProcessDimension, ProcessDomain } from '@stewra/shared-types';

/**
 * Deterministic extraction of process/style rule CANDIDATES from a user's free-text feedback comment
 * (memory-and-learning.md §3: extraction is deterministic; the model never silently authors a rule).
 * This is intentionally high-precision and conservative — it emits a candidate only when a comment
 * clearly signals a known style axis, because every candidate becomes a `proposed` rule the user must
 * confirm. Missing a signal is fine (nothing proposed); a false candidate is mild noise the user
 * dismisses, but we still keep the surface small to avoid nagging.
 *
 * At most one candidate per dimension, in a stable dimension order, so re-rating the same comment is
 * idempotent per axis (the capture step upserts on the axis anyway).
 */

export interface ProcessRuleCandidate {
  readonly dimension: ProcessDimension;
  /** The generalized "how", in plain language — what the user's comment implies as a standing rule. */
  readonly rule: string;
}

interface Signal {
  readonly dimension: ProcessDimension;
  readonly pattern: RegExp;
  readonly rule: string;
}

/**
 * The signal table. Order defines candidate order. Patterns are word-boundaried and case-insensitive.
 * Kept deliberately small and precise — these are the axes the user actually described wanting learned
 * (how emails are written, how many proofread passes, who gets CC'd).
 */
const EMAIL_SIGNALS: ReadonlyArray<Signal> = [
  {
    dimension: 'length',
    pattern: /\b(shorter|too long|more concise|be concise|keep it short|brief(er)?|tl;?dr)\b/i,
    rule: 'Keep it concise — short and to the point.',
  },
  {
    dimension: 'length',
    pattern: /\b(too short|more detail|elaborate|expand on|more thorough)\b/i,
    rule: 'Give fuller detail rather than being terse.',
  },
  {
    dimension: 'tone',
    pattern: /\b(warmer|friendl(y|ier)|less formal|more casual|more personal)\b/i,
    rule: 'Keep the tone warm and personable.',
  },
  {
    dimension: 'tone',
    pattern: /\b(more formal|more professional|less casual|too casual)\b/i,
    rule: 'Keep the tone formal and professional.',
  },
  {
    dimension: 'recipients',
    pattern: /\b(cc|carbon copy|copy in|loop in|loop them in)\b/i,
    rule: 'Consider who to CC based on the thread.',
  },
  {
    dimension: 'proofreading',
    pattern: /\b(proof-?read|typos?|double-?check|re-?read|spell-?check)\b/i,
    rule: 'Proofread carefully before sending.',
  },
];

/** Signals per domain. Only `email` is active today; other domains have no signals yet (return []). */
const SIGNALS_BY_DOMAIN: Partial<Record<ProcessDomain, ReadonlyArray<Signal>>> = {
  email: EMAIL_SIGNALS,
};

/**
 * Extract 0..n candidate rules a comment implies for a domain. At most one per dimension (first match
 * wins), preserving the signal-table order. Empty comment or unknown domain → no candidates.
 */
export function extractProcessRuleCandidates(
  domain: ProcessDomain,
  comment: string | null,
): ReadonlyArray<ProcessRuleCandidate> {
  if (comment === null || comment.trim().length === 0) {
    return [];
  }
  const signals = SIGNALS_BY_DOMAIN[domain];
  if (!signals) {
    return [];
  }

  const seen = new Set<ProcessDimension>();
  const candidates: ProcessRuleCandidate[] = [];
  for (const signal of signals) {
    if (seen.has(signal.dimension)) {
      continue;
    }
    if (signal.pattern.test(comment)) {
      seen.add(signal.dimension);
      candidates.push({ dimension: signal.dimension, rule: signal.rule });
    }
  }
  return candidates;
}
