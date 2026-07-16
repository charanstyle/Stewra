import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config/unifiedConfig.js';
import { AuthenticationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const SIGNATURE_HEADER = 'x-hub-signature-256';
const SIGNATURE_PREFIX = 'sha256=';

/**
 * Authenticate an inbound WhatsApp webhook as genuinely coming from Meta.
 *
 * The endpoint is necessarily UNAUTHENTICATED (Meta has no Stewra credentials), so this HMAC is the
 * only thing standing between the agent and an attacker who guesses the URL. It must run on the RAW
 * bytes: `JSON.parse` → `JSON.stringify` is not byte-identical (key order, whitespace, unicode escapes),
 * so re-serializing would compute a different digest and reject every legitimate request. The webhook
 * router therefore mounts `express.raw()` and is registered BEFORE the global `express.json()`.
 *
 * Note this proves the request came from *Meta* — it says nothing about WHO sent the message. The
 * phone→user binding is what establishes identity (see whatsappService).
 */
export function verifyWhatsappSignature(req: Request, _res: Response, next: NextFunction): void {
  const header = req.get(SIGNATURE_HEADER);
  if (header === undefined || !header.startsWith(SIGNATURE_PREFIX)) {
    logger.warn('whatsapp webhook: missing or malformed signature header');
    throw new AuthenticationError('Invalid webhook signature');
  }

  // express.raw() leaves the untouched bytes on req.body. Anything else means the router is misordered
  // (e.g. express.json() ran first) — fail loud rather than silently authenticate nothing.
  if (!Buffer.isBuffer(req.body)) {
    throw new Error(
      'whatsapp webhook: raw body unavailable — the webhook router must be mounted before express.json()',
    );
  }

  const expected = createHmac('sha256', config.whatsapp.appSecret).update(req.body).digest();
  const provided = Buffer.from(header.slice(SIGNATURE_PREFIX.length), 'hex');

  // timingSafeEqual throws on a length mismatch, so check that first — and compare in constant time so
  // the endpoint can't be used as an oracle to forge a signature byte by byte.
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    logger.warn('whatsapp webhook: signature mismatch — rejecting');
    throw new AuthenticationError('Invalid webhook signature');
  }

  next();
}
