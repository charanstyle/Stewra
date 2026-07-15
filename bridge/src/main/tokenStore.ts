import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SecretStore } from '../core/authState.js';

const TOKEN_FILE = 'device-token.enc';

/**
 * This device's long-lived Stewra token, encrypted by the OS keystore exactly like the WhatsApp session.
 *
 * It is deliberately NOT the user's access token. It authenticates one device on the `/bridge` namespace
 * and nothing else, so a stolen bridge token is not a stolen Stewra account — and the user can revoke it
 * from the web app without touching their password or their other devices.
 */
export class TokenStore {
  private readonly path: string;

  constructor(
    directory: string,
    private readonly secrets: SecretStore,
  ) {
    this.path = join(directory, TOKEN_FILE);
  }

  /** The saved token, or null if this device has never paired — or can no longer decrypt what it saved. */
  async read(): Promise<string | null> {
    try {
      const ciphertext = await readFile(this.path);
      return this.secrets.decrypt(ciphertext);
    } catch {
      // Missing, or written by a keystore this machine no longer has (a restored backup, a reinstall).
      // Both mean the same thing to the user: pair again. Half-recovering a token would only produce a
      // confusing 401 later, somewhere further from the cause.
      return null;
    }
  }

  async write(token: string): Promise<void> {
    await writeFile(this.path, this.secrets.encrypt(token));
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}
