import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from '@whiskeysockets/baileys';

/**
 * OS-backed encryption. In the app this is Electron's `safeStorage` (macOS Keychain, Windows DPAPI,
 * libsecret on Linux); in a test it is a fake. Injected rather than imported so that everything in
 * `core/` — including the code deciding how a user's WhatsApp session is stored — stays testable without
 * launching Electron.
 */
export interface SecretStore {
  encrypt(plaintext: string): Buffer;
  decrypt(ciphertext: Buffer): string;
}

/** What Baileys needs to resume a session, plus the two operations the app performs on it. */
export interface EncryptedAuthState {
  readonly state: AuthenticationState;
  /** Persist the credentials. Baileys calls this on every `creds.update`; losing one means re-pairing. */
  saveCreds(): Promise<void>;
  /** Destroy the local session. Called on logout, on a ban, and when the user revokes this device. */
  clear(): Promise<void>;
}

const CREDS_FILE = 'creds.enc';

/** Signal keys are one file each, named by type and id; `/` and `:` appear in ids and are not path-safe. */
const keyFile = (type: string, id: string): string => `${type}-${id.replace(/[/:]/g, '_')}.enc`;

/**
 * Baileys' auth state, encrypted at rest by the operating system's own keystore.
 *
 * This is the file that IS the user's WhatsApp session. Anyone who can read it can BE them on WhatsApp —
 * so it never touches disk in plaintext, and it never leaves this machine. Stewra's servers hold no copy
 * and have no way to ask for one. That is not a policy we promise to follow; it is a thing we arranged to
 * be incapable of doing.
 *
 * ⚠️ THE TRAP THAT SILENTLY BREAKS EVERYTHING. `app-state-sync-key` values must be rehydrated through
 * `proto.Message.AppStateSyncKeyData.fromObject` on the way OUT of storage. Skip it and app-state sync
 * quietly no-ops: no chat list, no contacts, no names — and NO ERROR, anywhere. You get a bridge that
 * connects, reports itself healthy, and does nothing, with nothing in the logs to say why.
 */
export async function useEncryptedAuthState(
  dir: string,
  store: SecretStore,
): Promise<EncryptedAuthState> {
  await mkdir(dir, { recursive: true });

  /**
   * Read one of our own encrypted files back. The type is whatever `JSON.parse` yields, because that is
   * the honest answer: Baileys' signal-key shapes are internal, protobuf-backed, and not modellable from
   * out here — asserting a type onto them would be a lie the compiler happens to accept. Baileys' own
   * reference auth-state does exactly this. What we DO guarantee is the boundary below: a file that will
   * not decrypt, or will not parse, is treated as no session at all.
   */
  const readEncrypted = async (file: string) => {
    try {
      const ciphertext = await readFile(join(dir, file));
      return JSON.parse(store.decrypt(ciphertext), BufferJSON.reviver);
    } catch {
      // Absent (first run) or unreadable (a keystore that no longer holds the key — a restored backup, a
      // different machine). Either way there is no session here, and the user re-pairs. We do NOT try to
      // salvage a half-decrypted one: a corrupt session reconnects into `badSession`, and that is a path
      // toward a ban rather than toward a working bridge.
      return undefined;
    }
  };

  const writeEncrypted = async (file: string, value: unknown): Promise<void> => {
    const json = JSON.stringify(value, BufferJSON.replacer);
    await writeFile(join(dir, file), store.encrypt(json));
  };

  const creds: AuthenticationCreds = (await readEncrypted(CREDS_FILE)) ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const result: { [id: string]: SignalDataTypeMap[T] } = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readEncrypted(keyFile(type, id));
              if (value === undefined || value === null) return;
              if (type === 'app-state-sync-key') {
                // The trap. Without this, the value stays a plain object, Baileys' protobuf code silently
                // does nothing with it, and the bridge looks healthy while being useless.
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              result[id] = value;
            }),
          );
          return result;
        },
        set: async (data) => {
          await Promise.all(
            Object.entries(data).flatMap(([type, values]) =>
              Object.entries(values ?? {}).map(async ([id, value]) => {
                if (value === null || value === undefined) {
                  await rm(join(dir, keyFile(type, id)), { force: true });
                  return;
                }
                await writeEncrypted(keyFile(type, id), value);
              }),
            ),
          );
        },
      },
    },
    saveCreds: async () => writeEncrypted(CREDS_FILE, creds),
    clear: async () => rm(dir, { recursive: true, force: true }),
  };
}
