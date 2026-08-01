/**
 * Compare `a.b.c` version triples numerically. True when `version` is at least `minimum`.
 *
 * One comparison, used by every gate that reads a device-reported version: the backend's bridge and
 * runner pairing floors, the runner update-notice check, and the web panel's "Update available" badge.
 * It lives in shared-types so the server that decides and the UI that displays can never drift apart.
 *
 * A malformed `version` returns false: these compare device-reported strings, and a build that cannot
 * state its own version correctly is not one to wave through.
 */
export function meetsMinimumVersion(version: string, minimum: string): boolean {
  const parse = (v: string): number[] => v.split('.').map((p) => Number.parseInt(p, 10));
  const got = parse(version);
  const want = parse(minimum);
  if (got.some(Number.isNaN) || got.length !== 3) return false;
  for (let i = 0; i < 3; i += 1) {
    const g = got[i] ?? 0;
    const w = want[i] ?? 0;
    if (g > w) return true;
    if (g < w) return false;
  }
  return true;
}
