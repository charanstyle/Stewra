/**
 * Which Chromium key storage backend the bridge should ask for on Linux.
 *
 * Chromium picks a backend from the desktop environment: libsecret on GNOME-like sessions, kwallet on
 * KDE, and the hardcoded-key `basic_text` store on anything it does not recognise — XFCE, LXQt, i3,
 * sway. `secretStore.ts` rightly refuses to run on `basic_text`, so on those desktops the bridge could
 * not start AT ALL even with gnome-keyring installed, running and unlocked. Verified on a Debian 13
 * XFCE session: same box, same keyring, the app starts as soon as the backend is named.
 *
 * Lives apart from main.ts so the decision can be tested without booting Electron — main.ts runs its
 * side effects on import.
 */

/** Chromium's libsecret-backed store. The value of the `--password-store` switch. */
export const LIBSECRET_BACKEND = 'gnome-libsecret';

/**
 * The backend to request, or `null` to leave Chromium's own choice alone.
 *
 * Returning `null` for KDE is deliberate: kwallet is the right store there. On GNOME libsecret is
 * already Chromium's choice, so naming it changes nothing. This can only widen where a real keyring is
 * found — when libsecret is genuinely missing Chromium still falls back to `basic_text`, and the loud
 * refusal in `secretStore.ts` still fires.
 */
export function linuxKeyStorageBackend(
  platform: NodeJS.Platform,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): string | null {
  if (platform !== 'linux') return null;
  // An explicit choice from whoever launched us wins; never override it.
  if (argv.some((arg) => arg.startsWith('--password-store='))) return null;
  if ((env['XDG_CURRENT_DESKTOP'] ?? '').toUpperCase().includes('KDE')) return null;
  return LIBSECRET_BACKEND;
}
