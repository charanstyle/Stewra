import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Autostart,
  AutostartDecision,
  DESKTOP_ENTRY_NAME,
  HIDDEN_FLAG,
  linuxExecPath,
  startedAtLogin,
} from '../main/autostart.js';
import type { LoginItemAdapter } from '../main/autostart.js';

/**
 * THE PROMISE: "tick the box and the bridge is there after you reboot."
 *
 * It was not. Electron's login-item API is macOS/Windows only and a silent no-op on Linux, so on the deb
 * and AppImage builds the checkbox could not even stay ticked — users turned it on, believed it, and found
 * Stewra had stopped relaying after every restart. These tests drive REAL files in a REAL directory,
 * because the bug was never in the intent; it was in whether anything was written to disk at all.
 */

const DEB_EXEC = '/opt/Stewra Bridge/stewra-bridge';

/** An adapter that fails the test if Linux ever reaches for it — the platform split must be real. */
const forbiddenLoginItem: LoginItemAdapter = {
  read: (): boolean => {
    throw new Error('the Linux path must never consult the macOS/Windows login-item API');
  },
  write: (): void => {
    throw new Error('the Linux path must never consult the macOS/Windows login-item API');
  },
};

/** A login item that behaves like a cooperative OS: what you write is what you read back. */
function recordingLoginItem(initial = false): LoginItemAdapter & { readonly writes: boolean[] } {
  const writes: boolean[] = [];
  let enabled = initial;
  return {
    writes,
    read: (): boolean => enabled,
    write: (value: boolean): void => {
      writes.push(value);
      enabled = value;
    },
  };
}

describe('Autostart on Linux', () => {
  let dir: string;
  let entry: string;

  const linux = (overrides: { packaged?: boolean; execPath?: string } = {}): Autostart =>
    new Autostart({
      platform: 'linux',
      packaged: overrides.packaged ?? true,
      autostartDir: dir,
      execPath: overrides.execPath ?? DEB_EXEC,
      loginItem: forbiddenLoginItem,
    });

  beforeEach(async () => {
    dir = join(await mkdtemp(join(tmpdir(), 'stewra-autostart-')), 'autostart');
    entry = join(dir, DESKTOP_ENTRY_NAME);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a real XDG entry, creating the directory, and reports itself enabled', async () => {
    // The directory genuinely does not exist yet — a fresh account has no ~/.config/autostart, and
    // failing to create it is the difference between "registered" and "silently did nothing".
    const autostart = linux();
    expect(await autostart.read()).toBe(false);

    expect(await autostart.write(true)).toBe(true);

    const contents = await readFile(entry, 'utf8');
    expect(contents).toContain('[Desktop Entry]');
    expect(contents).toContain('Type=Application');
    expect(await autostart.read()).toBe(true);
  });

  it('quotes an executable path containing spaces, so the deb install actually launches', async () => {
    // /opt/Stewra Bridge/stewra-bridge unquoted is read as a command plus a stray argument: the session
    // launches nothing, reports nothing, and the user simply has no bridge.
    await linux().write(true);

    expect(await readFile(entry, 'utf8')).toContain(`Exec="${DEB_EXEC}" ${HIDDEN_FLAG}`);
  });

  it('starts hidden, so logging in does not throw a window in the user\'s face', async () => {
    await linux().write(true);

    const exec = (await readFile(entry, 'utf8')).split('\n').find((line) => line.startsWith('Exec='));
    expect(exec).toContain(HIDDEN_FLAG);
    // And the flag has to be understood on the way back in, or the window shows up anyway.
    expect(startedAtLogin([process.execPath, 'main.js', HIDDEN_FLAG], false)).toBe(true);
  });

  it('treats an entry the desktop has disabled as off, not on', async () => {
    // GNOME's own UI disables an autostart entry by rewriting this key rather than deleting the file.
    // Reading "the file exists, therefore we are enabled" would show a tick for something that is off.
    //
    // The key is REPLACED, not appended. An earlier version of this test appended a second copy, which
    // produces a duplicate key in one group — malformed per the freedesktop spec, and resolved by real
    // parsers in ways this assertion has no business depending on. The fixture now matches what GNOME
    // actually writes to disk.
    const autostart = linux();
    await autostart.write(true);
    const disabled = (await readFile(entry, 'utf8')).replace(
      'X-GNOME-Autostart-enabled=true',
      'X-GNOME-Autostart-enabled=false',
    );
    expect(disabled).toContain('X-GNOME-Autostart-enabled=false');
    await writeFile(entry, disabled);

    expect(await autostart.read()).toBe(false);
  });

  it('treats Hidden=true as off — the disable the autostart spec actually mandates', async () => {
    // Found by running the real generated entry through `dex` in a Debian 13 container: with Hidden=true
    // appended, dex skipped it, while this code still answered "enabled". The spec is normative here — an
    // autostart entry with Hidden=true "MUST be ignored" — so that combination is a checkbox showing ON
    // for a bridge that will never come up, which is the whole failure this module was written to end.
    const autostart = linux();
    await autostart.write(true);
    await writeFile(entry, `${await readFile(entry, 'utf8')}Hidden=true\n`);

    expect(await autostart.read()).toBe(false);
  });

  it('re-enabling replaces a disabled entry outright, leaving no stale disable behind', async () => {
    // Switching back on has to actually undo the desktop's disable. Merging into the existing file, or
    // leaving Hidden=true in place, would write an entry that reads as enabled and still never launches.
    const autostart = linux();
    await autostart.write(true);
    await writeFile(entry, `${await readFile(entry, 'utf8')}Hidden=true\n`);

    expect(await autostart.write(true)).toBe(true);
    expect(await readFile(entry, 'utf8')).not.toContain('Hidden=true');
  });

  it('removes the entry when switched off, and stays off across a fresh instance', async () => {
    const autostart = linux();
    await autostart.write(true);

    expect(await autostart.write(false)).toBe(false);

    await expect(readFile(entry, 'utf8')).rejects.toThrow();
    expect(await linux().read()).toBe(false);
  });

  it('refuses to enable from a development run, and leaves nothing behind when it refuses', async () => {
    // The dev binary is Electron's own; registering it schedules Electron's welcome window at every login.
    const autostart = linux({ packaged: false });

    await expect(autostart.write(true)).rejects.toThrow(/development run/i);
    await expect(readFile(entry, 'utf8')).rejects.toThrow();
  });

  it('still allows switching OFF from a development run, so a bad entry can be cleared', async () => {
    // Someone who already has the wrong entry must be able to remove it with the same checkbox. Gating
    // the off-direction too would strand them with the very thing that is broken.
    await linux().write(true);

    expect(await linux({ packaged: false }).write(false)).toBe(false);
    await expect(readFile(entry, 'utf8')).rejects.toThrow();
  });

  it('raises a genuine filesystem fault instead of reporting "not enabled"', async () => {
    // A path that cannot be read is NOT the same as no registration. Collapsing the two would tell the
    // user autostart is off while hiding the reason they can't turn it on.
    const blocked = join(await mkdtemp(join(tmpdir(), 'stewra-autostart-')), 'not-a-directory');
    await writeFile(blocked, 'this is a file, not a directory');
    const autostart = new Autostart({
      platform: 'linux',
      packaged: true,
      autostartDir: blocked,
      execPath: DEB_EXEC,
      loginItem: forbiddenLoginItem,
    });

    await expect(autostart.read()).rejects.toThrow();
  });
});

describe('Autostart on macOS and Windows', () => {
  const options = {
    platform: 'darwin' as NodeJS.Platform,
    packaged: true,
    autostartDir: '/unused',
    execPath: '/Applications/Stewra Bridge.app/Contents/MacOS/Stewra Bridge',
  };

  it('delegates to the OS login item and reports what it reads back', async () => {
    const loginItem = recordingLoginItem();
    const autostart = new Autostart({ ...options, loginItem });

    expect(await autostart.read()).toBe(false);
    expect(await autostart.write(true)).toBe(true);
    expect(loginItem.writes).toEqual([true]);
    expect(await autostart.write(false)).toBe(false);
  });

  it('reports OFF when macOS accepts the registration but has not approved it', async () => {
    // macOS 13+ can leave a login item awaiting approval in System Settings. Echoing the value we asked
    // for would tick the box while nothing was actually registered — the user would find out at the next
    // reboot, which is exactly the failure this whole feature exists to prevent.
    const unapproved: LoginItemAdapter = { read: (): boolean => false, write: (): void => undefined };

    expect(await new Autostart({ ...options, loginItem: unapproved }).write(true)).toBe(false);
  });

  it('refuses to enable from a development run without touching the OS at all', async () => {
    const loginItem = recordingLoginItem();

    await expect(new Autostart({ ...options, packaged: false, loginItem }).write(true)).rejects.toThrow(
      /development run/i,
    );
    expect(loginItem.writes).toEqual([]);
  });
});

describe('linuxExecPath', () => {
  it('names the AppImage file rather than its throwaway mount point', () => {
    // An AppImage mounts at a fresh /tmp path per run. Writing that into a login entry produces a file
    // that points at nothing after the next reboot.
    expect(linuxExecPath({ APPIMAGE: '/home/me/Apps/Stewra-Bridge.AppImage' }, '/tmp/.mount_abc/bridge')).toBe(
      '/home/me/Apps/Stewra-Bridge.AppImage',
    );
  });

  it('uses the real executable for deb installs, where APPIMAGE is unset or blank', () => {
    expect(linuxExecPath({}, DEB_EXEC)).toBe(DEB_EXEC);
    expect(linuxExecPath({ APPIMAGE: '   ' }, DEB_EXEC)).toBe(DEB_EXEC);
  });
});

describe('startedAtLogin', () => {
  it('is true for either signal and false for a normal launch', () => {
    expect(startedAtLogin(['electron', 'main.js'], true)).toBe(true);
    expect(startedAtLogin(['electron', 'main.js', HIDDEN_FLAG], false)).toBe(true);
    expect(startedAtLogin(['electron', 'main.js'], false)).toBe(false);
  });
});

describe('AutostartDecision', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stewra-decision-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('remembers across instances, so a user who opts out is never re-enrolled', async () => {
    // The whole point: autostart is switched on for you ONCE. Forgetting this would silently re-enable a
    // setting someone had deliberately turned off, every time they re-paired.
    expect(await new AutostartDecision(dir).decided()).toBe(false);

    await new AutostartDecision(dir).remember('2026-08-03T00:00:00.000Z');

    expect(await new AutostartDecision(dir).decided()).toBe(true);
  });

  it('treats a corrupt marker as undecided rather than failing the pairing that just succeeded', async () => {
    await writeFile(join(dir, 'autostart-decision.json'), '{ this is not json');

    expect(await new AutostartDecision(dir).decided()).toBe(false);
  });
});
