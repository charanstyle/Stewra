/**
 * One machine runs ONE Stewra Bridge, linked to ONE Stewra account.
 *
 * `app.requestSingleInstanceLock()` enforces that — but it is keyed on the userData directory, so
 * `--user-data-dir=<somewhere else>` hands a second copy its own lock, its own device token and its own
 * WhatsApp session, and the two run side by side with nothing to say they are on the same computer. That
 * is not a hypothetical: it is how a second bridge was stood up on this Mac, and it is exactly what the
 * single-instance lock exists to prevent.
 *
 * So the flag is refused outright. Not "warned about", not "ignored and fall back to the default dir" —
 * Chromium has already consumed the switch by the time any of our code runs, so a bridge that carried on
 * would be running in the overridden profile while claiming otherwise. It exits instead.
 *
 * The honest limit: this closes the documented bypass, not every conceivable one. Someone who rebuilds the
 * app under a different `package.json` name gets a different default userData dir, and no check inside the
 * app can see that. The guard is against a second profile being started, not against a second app existing.
 */

/** Chromium's profile switch. Matched with one dash or two — its own parser accepts both. */
const USER_DATA_DIR_FLAG = 'user-data-dir';

/** Shown in the terminal and in the error box. One sentence saying what was refused, and why. */
export const SECOND_PROFILE_MESSAGE =
  'Stewra Bridge refuses --user-data-dir. One machine runs one bridge, linked to one Stewra account: a ' +
  'second profile would hold a second device token and a second WhatsApp session on the same computer. ' +
  'Quit the running bridge and start it normally, or unlink it from Stewra first.';

/**
 * The value of a `--user-data-dir` on the command line, or `null` when none was passed.
 *
 * Returns the empty string for a flag given with no value (`--user-data-dir` as the final argument):
 * still an override attempt, still refused, and `''` is not `null`.
 */
export function userDataOverride(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const bare = arg.startsWith('--') ? arg.slice(2) : arg.startsWith('-') ? arg.slice(1) : null;
    if (bare === null) continue;
    if (bare === USER_DATA_DIR_FLAG) return argv[i + 1] ?? '';
    if (bare.startsWith(`${USER_DATA_DIR_FLAG}=`)) return bare.slice(USER_DATA_DIR_FLAG.length + 1);
  }
  return null;
}
