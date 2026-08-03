import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * "Start when I log in", implemented per platform.
 *
 * Electron's `app.setLoginItemSettings` covers macOS and Windows and NOTHING else — on Linux it is not
 * merely unsupported, it is a silent no-op, and `getLoginItemSettings` always reports `false` back. The
 * bridge ships `deb` and `AppImage` targets, so before this module the checkbox on those builds could not
 * even stay ticked: users turned it on, believed it, and found the bridge dead after every reboot. Linux
 * therefore gets a real implementation here — an XDG autostart entry, which is the mechanism GNOME, KDE
 * and every other freedesktop-conformant session actually read at login.
 *
 * Nothing here can work from a development run on any platform. macOS registers the RUNNING app bundle
 * (see `LoginItemAdapter`), and the Linux entry has to name a stable executable path; under `npm start`
 * both resolve to Electron's own binary, which at login opens Electron's welcome window and no bridge.
 * `available` is that gate, and it is the same gate everywhere.
 */

/** The macOS/Windows side of autostart: Electron's login-item API, injected so this module stays testable. */
export interface LoginItemAdapter {
  read(): boolean;
  write(enabled: boolean): void;
}

export interface AutostartOptions {
  readonly platform: NodeJS.Platform;
  /** Packaged builds only — a dev run can only ever register the wrong executable. */
  readonly packaged: boolean;
  /** XDG autostart directory, normally `~/.config/autostart`. Linux only. */
  readonly autostartDir: string;
  /** The executable the login entry launches. Linux only — see `linuxExecPath`. */
  readonly execPath: string;
  readonly loginItem: LoginItemAdapter;
}

/** Basename of the XDG entry. Matches `linux.executableName` in electron-builder.yml. */
export const DESKTOP_ENTRY_NAME = 'stewra-bridge.desktop';

/**
 * The flag the login entry passes so the bridge knows to come up in the tray without showing its window.
 * macOS answers this with `wasOpenedAtLogin`; Linux has no equivalent, so we tell ourselves.
 */
export const HIDDEN_FLAG = '--hidden';

/** True when the process was started by a login entry rather than by a person double-clicking. */
export function startedAtLogin(argv: readonly string[], wasOpenedAtLogin: boolean): boolean {
  return wasOpenedAtLogin || argv.includes(HIDDEN_FLAG);
}

/**
 * The executable an XDG entry should name.
 *
 * An AppImage is mounted at a FRESH temporary path on every run, so `process.execPath` inside one points
 * at a directory that will not exist next boot. The runtime exports `APPIMAGE` with the real, stable path
 * of the .AppImage file itself, and that is the only thing worth writing into a login entry.
 */
export function linuxExecPath(env: NodeJS.ProcessEnv, execPath: string): string {
  const appImage = env['APPIMAGE'];
  return appImage !== undefined && appImage.trim().length > 0 ? appImage.trim() : execPath;
}

/**
 * Quote a path for a desktop entry's `Exec=` key. Required, not cosmetic: the deb installs to
 * `/opt/Stewra Bridge/stewra-bridge`, and an unquoted space there makes the session read the entry as a
 * command plus a stray argument, so nothing launches. Per the freedesktop spec, backslashes and double
 * quotes inside the quoted string are backslash-escaped.
 */
export function quoteExec(path: string): string {
  return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function desktopEntry(execPath: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=Stewra Bridge',
    'Comment=Holds the WhatsApp connection Stewra relays through',
    `Exec=${quoteExec(execPath)} ${HIDDEN_FLAG}`,
    'Icon=stewra-bridge',
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

/**
 * The two ways a desktop says "this entry exists, but do not run it".
 *
 * `Hidden=true` is the freedesktop autostart spec's own disable — an entry carrying it "MUST be ignored" —
 * and that is not theoretical: `dex`, a real implementation of that spec, skips such an entry outright.
 * `X-GNOME-Autostart-enabled=false` is GNOME's older extension, which its Startup Applications UI still
 * writes. Both are used to switch an entry off WITHOUT deleting the file, so reading "the file is there,
 * therefore we are enabled" reports a tick for something that will never launch — the exact lie this
 * module exists to stop telling.
 */
const DISABLED_PATTERNS = [/^Hidden\s*=\s*true\s*$/im, /^X-GNOME-Autostart-enabled\s*=\s*false\s*$/im];

/** ENOENT only — "there is no entry" is a real answer, any other fs error is a fault worth raising. */
function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export class Autostart {
  constructor(private readonly options: AutostartOptions) {}

  /** Whether autostart can be turned ON at all. Turning it off is always allowed — see `write`. */
  get available(): boolean {
    return this.options.packaged;
  }

  private get entryPath(): string {
    return join(this.options.autostartDir, DESKTOP_ENTRY_NAME);
  }

  /** Whether this app is registered to start at login, read from the OS rather than remembered. */
  async read(): Promise<boolean> {
    if (this.options.platform !== 'linux') return this.options.loginItem.read();
    try {
      const entry = await readFile(this.entryPath, 'utf8');
      // Present-but-disabled is OFF, not ON — see `DISABLED_PATTERNS`.
      return !DISABLED_PATTERNS.some((pattern) => pattern.test(entry));
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  /**
   * Register or clear autostart, then report what the OS says is true afterwards.
   *
   * The read-back is the point. macOS 13+ can accept a registration and still leave it awaiting the
   * user's approval in System Settings, and a checkbox that ticks itself while nothing was registered is
   * a worse outcome than one that admits the refusal.
   *
   * Failures propagate. An unwritable `~/.config/autostart` means the bridge will not come back after a
   * reboot, and the user has to hear that at the moment they ask for it, not discover it days later.
   */
  async write(enabled: boolean): Promise<boolean> {
    if (enabled && !this.available) {
      throw new Error(
        'Start at login needs the packaged Stewra Bridge app. This is a development run, so logging in ' +
          'would launch Electron rather than the bridge.',
      );
    }

    if (this.options.platform !== 'linux') {
      this.options.loginItem.write(enabled);
      return this.options.loginItem.read();
    }

    if (enabled) {
      await mkdir(this.options.autostartDir, { recursive: true });
      await writeFile(this.entryPath, desktopEntry(this.options.execPath), { mode: 0o644 });
    } else {
      await rm(this.entryPath, { force: true });
    }
    return this.read();
  }
}

const DECISION_FILE = 'autostart-decision.json';

const decisionSchema = z.object({ decidedAt: z.string().min(1) });

/**
 * Whether the user has already been given autostart once.
 *
 * The bridge turns autostart on by itself the first time a computer pairs, because a bridge that is not
 * running is a Stewra that has gone silent, and the setting was previously off by default and buried in a
 * footer where nobody found it. Doing that ONCE is a helpful default; doing it on every pair would
 * override someone who had deliberately switched it off, which is a different and much ruder thing.
 *
 * Plain JSON, unlike this app's other stores: a "we have done this already" marker is not a secret, and
 * encrypting it would make a lost keystore silently re-enable a setting the user turned off.
 */
export class AutostartDecision {
  private readonly path: string;

  constructor(directory: string) {
    this.path = join(directory, DECISION_FILE);
  }

  async decided(): Promise<boolean> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      // No marker means nobody has been offered autostart yet — the honest answer, not a stand-in.
      if (isNotFound(error)) return false;
      // A marker that exists and cannot be read is a real fault, and hiding it would let a permissions
      // problem quietly re-enable a setting on every pair.
      throw error;
    }

    try {
      return decisionSchema.safeParse(JSON.parse(raw)).success;
    } catch (error) {
      // Corrupt contents: we genuinely cannot tell whether the user has had their say. Treating it as
      // "not yet" costs at most one more banner they can dismiss, whereas throwing here would fail a
      // pairing that actually succeeded. Reported rather than absorbed.
      const reason = error instanceof Error ? error.message : String(error);
      console.error(
        `Stewra Bridge: the autostart marker at ${this.path} is unreadable (${reason}); treating it as undecided.`,
      );
      return false;
    }
  }

  async remember(decidedAt: string): Promise<void> {
    await writeFile(this.path, JSON.stringify({ decidedAt } satisfies z.infer<typeof decisionSchema>));
  }
}
