import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { config } from '../../config/unifiedConfig';

/**
 * Field-level authenticated encryption, at the SAME AES-256-GCM strength as the vault, but stored
 * INLINE in a column rather than as its own `vault_secrets` row. The vault's one-row-per-secret model
 * is right for a handful of OAuth tokens; it is the wrong granularity for tens of thousands of email
 * bodies. So we reuse the crypto (the same `config.vault.keyHex`), not the row model.
 *
 * The envelope format is identical to `EnvVault`'s (`iv.tag.ciphertext`, all base64), so both share
 * one key and one scheme. Bodies encrypted here never leave the control plane and never reach the
 * agent runtime.
 */
const ALGORITHM = 'aes-256-gcm';

function loadKey(keyHex: string): Buffer {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) {
    throw new Error('VAULT_KEY must decode to exactly 32 bytes');
  }
  return key;
}

const KEY = loadKey(config.vault.keyHex);

/** Encrypt UTF-8 plaintext into an `iv.tag.ciphertext` base64 envelope. */
export function encryptField(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${authTag.toString('base64')}.${ciphertext.toString('base64')}`;
}

/**
 * A separate HMAC subkey, derived from the same master key rather than BEING it. Using one key for two
 * primitives (AES-GCM and HMAC) is the kind of shortcut that is fine right up until it isn't, and HKDF
 * costs four lines. The `info` string domain-separates this use from any future derived key.
 */
const HMAC_KEY = Buffer.from(hkdfSync('sha256', KEY, Buffer.alloc(0), 'stewra:field-hmac:v1', 32));

/**
 * A deterministic, keyed handle for a value we must look up by equality but should not store in the
 * clear — currently a WhatsApp JID.
 *
 * This is an HMAC and NOT a bare SHA-256 for a specific reason: a phone number carries only ~10 digits
 * of entropy, so an unkeyed hash of one is reversible by brute force in seconds and would be security
 * theatre. Keyed with a secret the database dump does not contain, the handle is inert without the key.
 */
export function hmacField(plaintext: string): string {
  return createHmac('sha256', HMAC_KEY).update(plaintext, 'utf8').digest('hex');
}

/** Decrypt an `iv.tag.ciphertext` base64 envelope produced by {@link encryptField}. */
export function decryptField(envelope: string): string {
  const parts = envelope.split('.');
  const ivB64 = parts[0];
  const tagB64 = parts[1];
  const dataB64 = parts[2];
  if (parts.length !== 3 || ivB64 === undefined || tagB64 === undefined || dataB64 === undefined) {
    throw new Error('fieldCrypto: malformed ciphertext envelope');
  }

  const decipher = createDecipheriv(ALGORITHM, KEY, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}
