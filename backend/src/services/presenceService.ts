import type { Redis } from 'ioredis';
import type { PresenceStatus } from '@stewra/shared-types';
import { redis } from './redisClient.js';
import { config } from '../config/unifiedConfig.js';

/** Narrow an ioredis pipeline reply element (unknown) to a string, or null when absent/other. */
function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Narrow an ioredis pipeline reply element (unknown) to a non-negative count, defaulting to 0. */
function asCount(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0) || 0;
}

/**
 * Redis-backed presence. A user is "online" while they hold ≥1 socket whose heartbeat is still fresh —
 * tracked as a per-user sorted set of `socketId → lastHeartbeatMs`. Each backend instance re-stamps its
 * own live sockets on a timer (`refresh`); a socket whose score falls outside the `staleMs` window is
 * pruned lazily on every read/write. This is the crucial robustness property: if an instance crashes or
 * is redeployed it simply stops re-stamping, so its sockets age out and the user auto-goes-offline —
 * unlike a bare INCR/DECR counter, which leaks a permanent +1 on any unclean disconnect and pins the
 * user "online" forever.
 *
 * Keys:
 *  - `presence:socks:{userId}`  → ZSET of live socket ids scored by last-heartbeat epoch ms
 *  - `presence:seen:{userId}`   → ISO timestamp of the user's last transition to offline
 *
 * `connect`/`disconnect` return whether the user CROSSED an online/offline boundary, so the caller only
 * broadcasts a presence change on a real transition (not on every extra tab).
 */
export class PresenceService {
  private readonly redis: Redis;
  private readonly staleMs: number;

  constructor(client: Redis, staleMs: number) {
    this.redis = client;
    this.staleMs = staleMs;
  }

  private socksKey(userId: string): string {
    return `presence:socks:${userId}`;
  }

  private seenKey(userId: string): string {
    return `presence:seen:${userId}`;
  }

  /** Drop sockets whose heartbeat is older than the stale window, then return how many remain live. */
  private async liveCount(userId: string, now: number): Promise<number> {
    const key = this.socksKey(userId);
    await this.redis.zremrangebyscore(key, '-inf', now - this.staleMs);
    return this.redis.zcard(key);
  }

  /** Give the whole set a TTL so a fully-abandoned user's key eventually vanishes on its own. */
  private async touchTtl(key: string): Promise<void> {
    await this.redis.pexpire(key, this.staleMs * 2);
  }

  /** Record a new live socket. Returns true when the user just transitioned offline→online. */
  async connect(userId: string, socketId: string, now: number = Date.now()): Promise<boolean> {
    const key = this.socksKey(userId);
    const before = await this.liveCount(userId, now);
    await this.redis.zadd(key, now, socketId);
    await this.touchTtl(key);
    return before === 0;
  }

  /** Re-stamp a still-connected socket so it stays inside the liveness window. */
  async heartbeat(userId: string, socketId: string, now: number = Date.now()): Promise<void> {
    const key = this.socksKey(userId);
    await this.redis.zadd(key, now, socketId);
    await this.touchTtl(key);
  }

  /** Re-stamp many sockets in one round-trip (the per-instance heartbeat sweep). */
  async refresh(
    entries: ReadonlyArray<{ userId: string; socketId: string }>,
    now: number = Date.now(),
  ): Promise<void> {
    if (entries.length === 0) return;
    const pipeline = this.redis.pipeline();
    for (const { userId, socketId } of entries) {
      const key = this.socksKey(userId);
      pipeline.zadd(key, now, socketId);
      pipeline.pexpire(key, this.staleMs * 2);
    }
    await pipeline.exec();
  }

  /** Record a socket closing. Returns true when the user just transitioned online→offline. */
  async disconnect(userId: string, socketId: string, at: Date): Promise<boolean> {
    // `zrem` returns how many members it actually removed. If this socket wasn't tracked here (a
    // duplicate/late disconnect, or one already pruned as stale), nothing changed — so it's not our
    // transition and we must not re-broadcast offline or re-stamp last-seen.
    const removed = await this.redis.zrem(this.socksKey(userId), socketId);
    if (removed === 0) return false;
    const remaining = await this.liveCount(userId, at.getTime());
    if (remaining === 0) {
      await this.redis.set(this.seenKey(userId), at.toISOString());
      return true;
    }
    return false;
  }

  async isOnline(userId: string, now: number = Date.now()): Promise<boolean> {
    return (await this.liveCount(userId, now)) > 0;
  }

  async lastSeen(userId: string): Promise<string | null> {
    return this.redis.get(this.seenKey(userId));
  }

  /** Resolve current presence for a set of users in one round-trip (for a presence:subscribe reply). */
  async statuses(
    userIds: ReadonlyArray<string>,
    now: number = Date.now(),
  ): Promise<Array<{ userId: string; status: PresenceStatus; lastSeen: string | null }>> {
    if (userIds.length === 0) return [];
    // Prune every user's stale sockets first so the counts below reflect only live connections.
    const prune = this.redis.pipeline();
    for (const id of userIds) {
      prune.zremrangebyscore(this.socksKey(id), '-inf', now - this.staleMs);
    }
    await prune.exec();

    const pipeline = this.redis.pipeline();
    for (const id of userIds) {
      pipeline.zcard(this.socksKey(id));
      pipeline.get(this.seenKey(id));
    }
    const results = await pipeline.exec();
    // `results` is a flat [ [cardErr,card], [seenErr,seen], ... ] list in submission order.
    return userIds.map((userId, i) => {
      const count = asCount(results?.[i * 2]?.[1]);
      const seen = asStringOrNull(results?.[i * 2 + 1]?.[1]);
      const online = count > 0;
      return {
        userId,
        status: online ? 'online' : 'offline',
        lastSeen: seen,
      };
    });
  }
}

export const presenceService = new PresenceService(redis, config.presence.staleMs);
