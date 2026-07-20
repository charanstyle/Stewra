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

/** The stored device token, or null if this runner has never been paired. */
export async function loadToken(): Promise<string | null> {
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
