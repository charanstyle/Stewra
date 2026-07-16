import { db } from '../../database/index.js';
import { config } from '../../config/unifiedConfig.js';
import { encryptField, decryptField } from './fieldCrypto.js';

/**
 * The vault: the ONLY place secrets (e.g. OAuth tokens) live, encrypted at rest. Callers store a
 * secret and get back an opaque handle (`ref`); they later read the secret back by handle. The
 * agent runtime never receives a vault handle or a secret. Dev impl uses AES-256-GCM with a key
 * from config; swap for a cloud KMS later behind this same interface.
 */
export interface IVault {
  put(secret: string): Promise<string>;
  get(ref: string): Promise<string>;
  /** Permanently remove a stored secret. Used when a token is superseded (reconnect) or revoked
   * (disconnect) — we do not keep dead credentials at rest. A missing ref is a no-op. */
  delete(ref: string): Promise<void>;
}

export class EnvVault implements IVault {
  constructor(keyHex: string) {
    // Fail loud on a bad key at construction, matching the previous behaviour. The actual crypto
    // (and the same validation) now lives in fieldCrypto, which this class delegates to.
    const key = Buffer.from(keyHex, 'hex');
    if (key.length !== 32) {
      throw new Error('VAULT_KEY must decode to exactly 32 bytes');
    }
  }

  async put(secret: string): Promise<string> {
    const envelope = encryptField(secret);

    const row = await db
      .insertInto('vault_secrets')
      .values({ ciphertext: envelope })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async get(ref: string): Promise<string> {
    const row = await db
      .selectFrom('vault_secrets')
      .select('ciphertext')
      .where('id', '=', ref)
      .executeTakeFirst();
    if (!row) {
      throw new Error(`vault: no secret for ref ${ref}`);
    }

    return decryptField(row.ciphertext);
  }

  async delete(ref: string): Promise<void> {
    await db.deleteFrom('vault_secrets').where('id', '=', ref).execute();
  }
}

export const vault: IVault = new EnvVault(config.vault.keyHex);
