import { Redis } from 'ioredis';
import * as Sentry from '@sentry/node';
import { config } from '../config/unifiedConfig.js';
import { logger } from '../utils/logger.js';

/**
 * Redis is a required dependency (realtime layer). This module owns connection creation so the URL is
 * read once from config and every client is built the same way. `createRedisClient` mints a fresh
 * connection (the Socket.IO adapter needs its own pub + sub pair); `redis` is the shared app-side
 * client used by the presence store.
 */
export function createRedisClient(): Redis {
  const client = new Redis(config.redis.url, {
    // Fail loud early rather than queueing commands forever against a dead Redis.
    maxRetriesPerRequest: 3,
    lazyConnect: false,
  });
  client.on('error', (err: Error) => {
    // Redis is a hard dependency of the realtime layer and of the fail-closed rate limiter, so an error
    // here is never cosmetic. Sentry groups by fingerprint, so a storm arrives as one issue with a
    // count rather than as noise.
    Sentry.captureException(err, { tags: { surface: 'redis' } });
    logger.error('redis client error', { error: err.message });
  });
  return client;
}

/** Shared app-side client (presence reads/writes). Adapter clients are created separately. */
export const redis: Redis = createRedisClient();
