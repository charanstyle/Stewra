import { createAdapter } from '@socket.io/redis-adapter';
import { createRedisClient } from '../services/redisClient.js';
import { config } from '../config/unifiedConfig.js';
import { logger } from '../utils/logger.js';
import type { AppServer } from './types.js';

/**
 * Wire the Socket.IO Redis adapter so rooms and broadcasts fan out across every backend instance (a
 * message emitted on instance A reaches a socket held by instance B). The adapter needs its OWN
 * dedicated pub + sub connection pair — separate from the shared app-side client — because the sub
 * connection enters Redis subscriber mode and can't also serve normal commands.
 *
 * Returns the two clients so the lifecycle owner can close them on graceful shutdown.
 */
export function attachRedisAdapter(io: AppServer): { pub: ReturnType<typeof createRedisClient>; sub: ReturnType<typeof createRedisClient> } {
  const pub = createRedisClient();
  const sub = createRedisClient();
  io.adapter(createAdapter(pub, sub, { key: config.redis.adapterKey }));
  logger.info('Socket.IO Redis adapter attached');
  return { pub, sub };
}
