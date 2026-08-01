import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { BridgeAllowedChat } from '@stewra/shared-types';
import type { SecretStore } from '../core/authState.js';

const ALLOWED_CHATS_FILE = 'allowed-chats.enc';
const CHAT_DIRECTORY_FILE = 'chat-directory.enc';

/**
 * What the user ticked survives a restart, or unticking would happen silently every launch. Persisted
 * ONLY on this machine, encrypted by the OS keystore exactly like the WhatsApp session and the device
 * token — the ticks name other people's chats, which is not something to leave in plaintext on disk.
 */
const allowedChatsSchema = z.array(
  z.object({
    jid: z.string().min(1),
    displayName: z.string(),
    isSelfChat: z.boolean(),
  }),
);

export class AllowedChatsStore {
  private readonly path: string;

  constructor(
    directory: string,
    private readonly secrets: SecretStore,
  ) {
    this.path = join(directory, ALLOWED_CHATS_FILE);
  }

  /**
   * The saved ticks, or null when there are none — never saved, wiped, or written by a keystore this
   * machine no longer has. Null over a half-recovered list because the failure direction matters:
   * "no ticks" means nothing beyond the self-chat leaves this computer, which is the safe default.
   */
  async read(): Promise<BridgeAllowedChat[] | null> {
    let raw: unknown;
    try {
      raw = JSON.parse(this.secrets.decrypt(await readFile(this.path)));
    } catch {
      return null;
    }
    const parsed = allowedChatsSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  async write(chats: readonly BridgeAllowedChat[]): Promise<void> {
    await writeFile(this.path, this.secrets.encrypt(JSON.stringify(chats)));
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}

/**
 * The chat directory's local cache, so the picker is not empty after a restart (Baileys keeps no
 * store — without this, every launch starts blind until chats message again). Same encryption, same
 * reasoning: it is a list of the user's contacts. The content is `ChatDirectory.serialize()` output
 * and is validated by `hydrate()` on the way back in, so this store carries it as an opaque string.
 */
export class ChatDirectoryCache {
  private readonly path: string;

  constructor(
    directory: string,
    private readonly secrets: SecretStore,
  ) {
    this.path = join(directory, CHAT_DIRECTORY_FILE);
  }

  /** The cached snapshot, or null when absent/undecryptable — the directory just starts empty. */
  async read(): Promise<string | null> {
    try {
      return this.secrets.decrypt(await readFile(this.path));
    } catch {
      return null;
    }
  }

  async write(serialized: string): Promise<void> {
    await writeFile(this.path, this.secrets.encrypt(serialized));
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}
