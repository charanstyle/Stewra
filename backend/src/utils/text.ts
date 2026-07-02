/**
 * Lexical-search helpers. Deterministic, dependency-free normalization so the same rules apply when
 * we STORE a purpose (agent_insights.purpose_norm, agent_memory.purpose_norm) and when we SEARCH
 * memory for a new task. Keeping both sides identical is what makes "same or similar task" matching
 * predictable.
 */

/** Common English words that carry no matching signal — dropped from keyword extraction. */
const STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'in', 'is', 'it', 'my',
  'of', 'on', 'or', 'that', 'the', 'to', 'up', 'was', 'what', 'when', 'with', 'your',
]);

/** Lowercase, strip punctuation to spaces, collapse runs of whitespace. */
export function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Distinct, order-preserving, non-stopword tokens from a string (for keyword matching/labels). */
export function keywords(input: string): ReadonlyArray<string> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of normalizeText(input).split(' ')) {
    if (token.length === 0 || STOPWORDS.has(token) || seen.has(token)) {
      continue;
    }
    seen.add(token);
    out.push(token);
  }
  return out;
}
