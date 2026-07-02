import type Redis from 'ioredis';
import type { PresenceStatus } from '@stewra/shared-types';
import { redis } from './redisClient';

/** Narrow an ioredis pipeline reply element (unknown) to a string, or null when absent/other. */
function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Redis-backed presence. A user is "online" while they hold ≥1 live socket on ANY backend instance —
 * so we track a per-user connection COUNT in Redis (survives multi-instance fan-out), not a per-process
 * boolean. `lastSeen` is stamped on every disconnect so an offline user still shows a "last seen" time.
 *
 * Keys:
 *  - `presence:conn:{userId}`  → integer count of live sockets (INCR/DECR; deleted at zero)
 *  - `presence:seen:{userId}`  → ISO timestamp of the user's last disconnect
 *
 * `connect`/`disconnect` return whether the user CROSSED an online/offline boundary, so the caller only
 * broadcasts a presence change on a real transition (not on every extra tab).
 */
export class PresenceService {
  private readonly redis: Redis;

  constructor(client: Redis) {
    this.redis = client;
  }

  private connKey(userId: string): string {
    return `presence:conn:${userId}`;
  }

  private seenKey(userId: string): string {
    return `presence:seen:${userId}`;
  }

  /** Record a new live socket. Returns true when the user just transitioned offline→online. */
  async connect(userId: string): Promise<boolean> {
    const count = await this.redis.incr(this.connKey(userId));
    return count === 1;
  }

  /** Record a socket closing. Returns true when the user just transitioned online→offline. */
  async disconnect(userId: string, at: Date): Promise<boolean> {
    const count = await this.redis.decr(this.connKey(userId));
    if (count <= 0) {
      // Clamp: never leave a negative counter lingering from a double-decrement.
      await this.redis.del(this.connKey(userId));
      await this.redis.set(this.seenKey(userId), at.toISOString());
      return true;
    }
    return false;
  }

  async isOnline(userId: string): Promise<boolean> {
    const raw = await this.redis.get(this.connKey(userId));
    return raw !== null && Number(raw) > 0;
  }

  async lastSeen(userId: string): Promise<string | null> {
    return this.redis.get(this.seenKey(userId));
  }

  /** Resolve current presence for a set of users in one round-trip (for a presence:subscribe reply). */
  async statuses(
    userIds: ReadonlyArray<string>,
  ): Promise<Array<{ userId: string; status: PresenceStatus; lastSeen: string | null }>> {
    if (userIds.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const id of userIds) {
      pipeline.get(this.connKey(id));
      pipeline.get(this.seenKey(id));
    }
    const results = await pipeline.exec();
    // `results` is a flat [ [connErr,conn], [seenErr,seen], ... ] list in submission order.
    return userIds.map((userId, i) => {
      const conn = asStringOrNull(results?.[i * 2]?.[1]);
      const seen = asStringOrNull(results?.[i * 2 + 1]?.[1]);
      const online = conn !== null && Number(conn) > 0;
      return {
        userId,
        status: online ? 'online' : 'offline',
        lastSeen: seen,
      };
    });
  }
}

export const presenceService = new PresenceService(redis);
