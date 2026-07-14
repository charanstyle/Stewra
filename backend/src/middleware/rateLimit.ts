import type { NextFunction, Request, Response } from 'express';
import { redis } from '../services/redisClient';
import { RateLimitError } from '../utils/errors';
import { logger } from '../utils/logger';

/**
 * A fixed-window rate limiter, counted in Redis so the budget is shared across replicas — a per-process
 * limiter running on N replicas is really an N× limiter, which is not a limiter.
 *
 * Built for endpoints that are UNAUTHENTICATED and guessable: the Stewra Bridge's pairing-code
 * redemption, where a correct guess yields a device token that can speak for a user. The code is
 * short-lived and drawn from ~29^6 possibilities, but "an attacker would need a lot of tries" is only a
 * defence if something is actually counting the tries.
 *
 * ⚠️ The bucket is GLOBAL (per endpoint), not per-IP, and that is a considered choice rather than a
 * simplification. This app does not configure Express's `trust proxy`, so behind the production reverse
 * proxy `req.ip` is the PROXY's address — every request would land in one bucket, and a per-IP limiter
 * would be either a no-op or a self-inflicted outage for all users at once. A global bucket has neither
 * failure mode, and it is strictly the stronger guarantee against the attack that actually matters here:
 * an attacker rotating through IPs (or a botnet) defeats a per-IP limit entirely, and does not dent this
 * one. The cost is that an attacker can burn the shared budget and delay a legitimate pairing — which is
 * a nuisance, not a compromise, and is why the limit is set well above real pairing volume (a user pairs
 * a device roughly once, ever).
 *
 * If `trust proxy` is configured later, a per-IP dimension is worth ADDING here, alongside this one.
 */
interface RateLimitOptions {
  /** Namespace, so two limiters never share a counter. */
  readonly key: string;
  readonly windowSeconds: number;
  readonly max: number;
}

export function rateLimit(options: RateLimitOptions) {
  return (_req: Request, _res: Response, next: NextFunction): void => {
    void (async (): Promise<void> => {
      const redisKey = `ratelimit:${options.key}`;
      try {
        const hits = await redis.incr(redisKey);
        // Set the TTL only when we created the counter. Re-setting it on every hit would let a sustained
        // attack push the window out indefinitely and thereby keep resetting its own budget.
        if (hits === 1) {
          await redis.expire(redisKey, options.windowSeconds);
        }
        if (hits > options.max) {
          logger.warn('rate limit exceeded', { key: options.key, hits, max: options.max });
          next(new RateLimitError('Too many attempts. Please wait and try again.'));
          return;
        }
        next();
      } catch (error) {
        // FAIL CLOSED. A limiter that opens when its store is down protects nothing at precisely the
        // moment an attacker would most like it gone. Redis is already a hard dependency of this app (the
        // realtime layer requires it), so a Redis outage is an outage regardless; taking these routes
        // down with it is the honest behaviour, not an extra cost.
        logger.error('rate limiter unavailable; refusing request', {
          key: options.key,
          error: error instanceof Error ? error.message : String(error),
        });
        next(new RateLimitError('Service temporarily unavailable. Please try again shortly.'));
      }
    })();
  };
}
