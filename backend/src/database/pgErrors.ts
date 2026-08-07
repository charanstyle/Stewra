/**
 * Recognising the Postgres errors that are a normal outcome rather than a fault.
 *
 * A unique index doing its job is not an internal error, and a caller that cannot tell the two apart
 * either reports "something went wrong" for a duplicate name, or — worse — pre-checks for the
 * duplicate and races with itself. The check belongs where the database made the decision.
 */

/** `unique_violation`. https://www.postgresql.org/docs/current/errcodes-appendix.html */
const UNIQUE_VIOLATION = '23505';

function hasCode(error: unknown): error is { readonly code: unknown } {
  return typeof error === 'object' && error !== null && 'code' in error;
}

/** True when the driver rejected a write because a unique index already held that key. */
export function isUniqueViolation(error: unknown): boolean {
  return hasCode(error) && error.code === UNIQUE_VIOLATION;
}
