import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where the runner keeps its long-lived device token at rest.
 *
 * The Electron bridge encrypts its token with the OS keystore (`safeStorage`). A headless runner has no
 * keystore and no desktop session to unlock one, so the honest equivalent is a file locked to the owner
 * (0600) in a directory locked to the owner (0700). That is the same protection SSH gives `~/.ssh/id_*`,
 * and it is the strongest guarantee available to a headless process: anyone who can read this file already
 * has the user's shell, at which point the token is the least of it.
 *
 * The directory is NOT configurable to a world-readable place: it is always under the user's home.
 */
const CONFIG_DIR = join(homedir(), '.stewra-runner');
const TOKEN_FILE = join(CONFIG_DIR, 'device-token');

/** Persist the device token with owner-only permissions. Overwrites any previous token. */
export async function saveToken(token: string): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(TOKEN_FILE, token, { encoding: 'utf8', mode: 0o600 });
  // `writeFile`'s mode only applies on creation; re-assert it so an existing, looser file is tightened.
  await chmod(TOKEN_FILE, 0o600);
}

/**
 * The token a HOSTED runner was handed through its environment, or null on a paired machine.
 *
 * A hosted container never runs `pair`: Stewra created the device row itself and injected the token at
 * provision time, because the pair-code dance exists to authorise a process Stewra cannot see — and this
 * one it started. Doubling as the hosted-mode signal keeps "am I hosted?" answerable from one place
 * instead of a second env var that could disagree with this one.
 */
export function hostedDeviceToken(): string | null {
  const fromEnv = process.env['STEWRA_RUNNER_DEVICE_TOKEN'];
  return fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv.trim() : null;
}

/**
 * The device token: the environment's (hosted) ahead of the stored file (paired), or null if neither.
 *
 * The environment wins so re-provisioning a container onto an existing home volume cannot resurrect a
 * revoked token that happens to still be sitting on that disk.
 */
export async function loadToken(): Promise<string | null> {
  const hosted = hostedDeviceToken();
  if (hosted !== null) return hosted;
  try {
    const token = (await readFile(TOKEN_FILE, 'utf8')).trim();
    return token.length > 0 ? token : null;
  } catch {
    // Missing file is the normal "not paired yet" state, not an error.
    return null;
  }
}

/** Remove the stored token — used when the server revokes this device. */
export async function clearToken(): Promise<void> {
  await rm(TOKEN_FILE, { force: true });
}
