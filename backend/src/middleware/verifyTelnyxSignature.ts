import { createPublicKey, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config/unifiedConfig.js';
import { AuthenticationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const SIGNATURE_HEADER = 'telnyx-signature-ed25519';
const TIMESTAMP_HEADER = 'telnyx-timestamp';
/** Telnyx signs `${timestamp}|${rawBody}`; a delivery older than this is replayed, not live. */
const MAX_SKEW_SECONDS = 5 * 60;
/** SubjectPublicKeyInfo prefix for a raw 32-byte Ed25519 key (RFC 8410), so node can load it. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

let cachedKey: KeyObject | null = null;
function publicKey(): KeyObject {
  if (cachedKey !== null) return cachedKey;
  if (!config.telnyxInbound.enabled) {
    throw new Error('verifyTelnyxSignature mounted while TELNYX_INBOUND_SMS_ENABLED=false');
  }
  const raw = Buffer.from(config.telnyxInbound.publicKey, 'base64');
  if (raw.length !== 32) {
    throw new Error('TELNYX_PUBLIC_KEY is not a 32-byte Ed25519 key');
  }
  cachedKey = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
  return cachedKey;
}

/**
 * Authenticate an inbound Telnyx webhook as genuinely Telnyx's. The endpoint is unauthenticated by
 * necessity (Telnyx holds no Stewra credentials), so this Ed25519 signature over the timestamp and the
 * RAW bytes is the only gate — hence `express.raw()` on the router and a mount before `express.json()`,
 * for the same reason as the Meta webhooks. The timestamp bound keeps a captured delivery from being
 * replayed later to plant a code in the inbox.
 */
export function verifyTelnyxSignature(req: Request, _res: Response, next: NextFunction): void {
  const signature = req.get(SIGNATURE_HEADER);
  const timestamp = req.get(TIMESTAMP_HEADER);
  if (signature === undefined || timestamp === undefined || !/^\d+$/.test(timestamp)) {
    logger.warn('telnyx webhook: missing or malformed signature headers');
    throw new AuthenticationError('Invalid webhook signature');
  }
  if (!Buffer.isBuffer(req.body)) {
    throw new Error('telnyx webhook: raw body unavailable — the webhook router must be mounted before express.json()');
  }
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (age > MAX_SKEW_SECONDS) {
    logger.warn('telnyx webhook: timestamp outside the accepted window — rejecting', { age });
    throw new AuthenticationError('Invalid webhook signature');
  }
  // Checked before `verify` rather than around it. An Ed25519 signature is exactly 64 bytes, so anything
  // else is a malformed request — the caller's fault, answered like any other bad signature. Wrapping the
  // call in try/catch instead would have caught OUR faults too: `publicKey()` throws when TELNYX_PUBLIC_KEY
  // is not a 32-byte key, and that was being reported to Telnyx as "invalid signature" and logged as a
  // warning — a webhook rejecting every genuine delivery forever, with nothing on fire.
  const signatureBytes = Buffer.from(signature, 'base64');
  if (signatureBytes.length !== 64) {
    logger.warn('telnyx webhook: signature is not a 64-byte Ed25519 signature — rejecting');
    throw new AuthenticationError('Invalid webhook signature');
  }
  const signed = Buffer.concat([Buffer.from(`${timestamp}|`, 'utf8'), req.body]);
  if (!verify(null, signed, publicKey(), signatureBytes)) {
    logger.warn('telnyx webhook: signature mismatch — rejecting');
    throw new AuthenticationError('Invalid webhook signature');
  }
  next();
}
