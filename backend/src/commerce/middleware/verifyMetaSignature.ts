import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../../config/unifiedConfig.js';
import { AuthenticationError, ServiceUnavailableError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

const SIGNATURE_HEADER = 'x-hub-signature-256';
const SIGNATURE_PREFIX = 'sha256=';

/**
 * Authenticate an inbound commerce webhook as genuinely coming from Meta.
 *
 * Same mechanism as `middleware/verifyWhatsappSignature`, keyed by a DIFFERENT app secret — the
 * commerce Meta app, not the personal-assistant one. It is a separate middleware rather than a
 * parameter to that one because the two must not be able to verify each other's traffic: a payload
 * signed by the assistant's app would otherwise be accepted here and routed to a tenant.
 *
 * The stakes are higher on this endpoint than on the assistant's. Anyone who could forge a signature
 * could inject a message into any organization's inbox by naming its WABA id, so this HMAC is the
 * only thing between an unauthenticated URL and every tenant's data.
 *
 * It must run on the RAW bytes: `JSON.parse` → `JSON.stringify` is not byte-identical, so
 * re-serializing computes a different digest and rejects every legitimate request. Hence the router
 * mounts `express.raw()` and is registered BEFORE the global `express.json()`.
 */
export function verifyMetaSignature(req: Request, _res: Response, next: NextFunction): void {
  const meta = config.metaCommerce;
  if (!meta.enabled) {
    // No app secret means nothing can be verified. Refusing is the only safe answer — accepting
    // unverified payloads "because the feature is off" would be an open door, not a disabled one.
    next(new ServiceUnavailableError('The commerce webhook is not configured.'));
    return;
  }

  const header = req.get(SIGNATURE_HEADER);
  if (header === undefined || !header.startsWith(SIGNATURE_PREFIX)) {
    logger.warn('commerce webhook: missing or malformed signature header');
    next(new AuthenticationError('Invalid webhook signature'));
    return;
  }

  // express.raw() leaves the untouched bytes here. Anything else means the router is misordered
  // (express.json() ran first) — fail loud rather than silently authenticate nothing.
  if (!Buffer.isBuffer(req.body)) {
    next(
      new Error(
        'commerce webhook: raw body unavailable — the webhook router must be mounted before express.json()',
      ),
    );
    return;
  }

  const expected = createHmac('sha256', meta.appSecret).update(req.body).digest();
  const provided = Buffer.from(header.slice(SIGNATURE_PREFIX.length), 'hex');

  // timingSafeEqual throws on a length mismatch, so check that first — and compare in constant time
  // so the endpoint cannot be used as an oracle to forge a signature byte by byte.
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    logger.warn('commerce webhook: signature mismatch — rejecting');
    next(new AuthenticationError('Invalid webhook signature'));
    return;
  }

  next();
}
