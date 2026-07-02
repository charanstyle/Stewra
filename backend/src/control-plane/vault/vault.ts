import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { db } from '../../database/index';
import { config } from '../../config/unifiedConfig';

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

const ALGORITHM = 'aes-256-gcm';

export class EnvVault implements IVault {
  private readonly key: Buffer;

  constructor(keyHex: string) {
    const key = Buffer.from(keyHex, 'hex');
    if (key.length !== 32) {
      throw new Error('VAULT_KEY must decode to exactly 32 bytes');
    }
    this.key = key;
  }

  async put(secret: string): Promise<string> {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const envelope = `${iv.toString('base64')}.${authTag.toString('base64')}.${ciphertext.toString('base64')}`;

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

    const parts = row.ciphertext.split('.');
    const ivB64 = parts[0];
    const tagB64 = parts[1];
    const dataB64 = parts[2];
    if (parts.length !== 3 || ivB64 === undefined || tagB64 === undefined || dataB64 === undefined) {
      throw new Error('vault: malformed ciphertext envelope');
    }

    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  }

  async delete(ref: string): Promise<void> {
    await db.deleteFrom('vault_secrets').where('id', '=', ref).execute();
  }
}

export const vault: IVault = new EnvVault(config.vault.keyHex);
