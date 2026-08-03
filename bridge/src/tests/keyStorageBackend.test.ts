import { describe, expect, it } from 'vitest';
import { LIBSECRET_BACKEND, linuxKeyStorageBackend } from '../main/keyStorageBackend.js';

/**
 * THE BUG: on a Debian 13 XFCE box with gnome-keyring installed, running and unlocked, the bridge
 * refused to start — "no usable system keyring". The keyring was fine. Chromium simply did not
 * recognise XFCE, so it selected its hardcoded-key `basic_text` store, and secretStore.ts correctly
 * refuses that. Naming the backend made the same box start on the first try.
 *
 * These assert the decision, not the wiring: the failure mode is choosing wrong for a desktop, and
 * the two directions that must NEVER be broken are KDE (kwallet is right there) and an explicit
 * `--password-store=` from whoever launched the app.
 */

const NO_ARGS: readonly string[] = [];

describe('which key storage backend to request on Linux', () => {
  it('names libsecret on a desktop Chromium does not recognise — the XFCE bug', () => {
    expect(linuxKeyStorageBackend('linux', NO_ARGS, { XDG_CURRENT_DESKTOP: 'XFCE' })).toBe(
      LIBSECRET_BACKEND,
    );
  });

  it('names libsecret on the other unrecognised desktops that hit the same trap', () => {
    for (const desktop of ['LXQt', 'i3', 'sway', 'MATE', '']) {
      expect(linuxKeyStorageBackend('linux', NO_ARGS, { XDG_CURRENT_DESKTOP: desktop })).toBe(
        LIBSECRET_BACKEND,
      );
    }
  });

  it('names libsecret when the desktop is not advertised at all', () => {
    expect(linuxKeyStorageBackend('linux', NO_ARGS, {})).toBe(LIBSECRET_BACKEND);
  });

  it('leaves KDE alone, because kwallet is the right store there', () => {
    expect(linuxKeyStorageBackend('linux', NO_ARGS, { XDG_CURRENT_DESKTOP: 'KDE' })).toBeNull();
  });

  it('leaves KDE alone however the session spells it', () => {
    // Real sessions report colon-separated lists and mixed case: "KDE", "plasma:KDE".
    for (const desktop of ['kde', 'plasma:KDE', 'KDE:plasmawayland']) {
      expect(linuxKeyStorageBackend('linux', NO_ARGS, { XDG_CURRENT_DESKTOP: desktop })).toBeNull();
    }
  });

  it('never overrides an explicit choice from whoever launched the app', () => {
    const argv = ['/opt/Stewra Bridge/stewra-bridge', '--password-store=kwallet6'];
    expect(linuxKeyStorageBackend('linux', argv, { XDG_CURRENT_DESKTOP: 'XFCE' })).toBeNull();
  });

  it('leaves macOS and Windows untouched — they have a real OS keystore already', () => {
    expect(linuxKeyStorageBackend('darwin', NO_ARGS, {})).toBeNull();
    expect(linuxKeyStorageBackend('win32', NO_ARGS, {})).toBeNull();
  });

  it('does not mistake a desktop that merely contains the letters for KDE', () => {
    // GNOME must still get libsecret; only a real KDE session may opt out.
    expect(linuxKeyStorageBackend('linux', NO_ARGS, { XDG_CURRENT_DESKTOP: 'GNOME' })).toBe(
      LIBSECRET_BACKEND,
    );
  });
});
