import * as Sentry from '@sentry/node';
import type { ZodType } from 'zod';
import { logger } from '../utils/logger';
import type { AppServer, AppSocket } from './types';

/** Max events a single socket may emit inside one rolling window before we start dropping them. */
const RATE_LIMIT_MAX_EVENTS = 60;
const RATE_LIMIT_WINDOW_MS = 10_000;

/**
 * Base class every feature socket handler extends (chat, calls, presence, stewra-voice). It centralizes
 * the cross-cutting concerns so each handler only writes its own logic:
 *  - per-socket, per-event rate limiting (a rolling token bucket) so one client can't flood the bus;
 *  - Zod validation of every inbound payload against the shared-types `realtime/payloads` contract —
 *    an invalid payload is rejected (optionally acked with an error), never passed to the handler;
 *  - error capture to Sentry + structured logs so a throwing handler never takes the connection down;
 *  - a `cleanup()` registry drained on disconnect (leave rooms, clear timers, release presence).
 *
 * Handlers register listeners via `this.on(event, schema, fn)` and side effects via `this.onCleanup(fn)`.
 */
export abstract class BaseSocketHandler {
  protected readonly io: AppServer;
  protected readonly socket: AppSocket;
  protected readonly userId: string;
  private readonly cleanups: Array<() => void | Promise<void>> = [];
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(io: AppServer, socket: AppSocket) {
    this.io = io;
    this.socket = socket;
    this.userId = socket.data.userId;
  }

  /** Register the handler's listeners. Called once per connection by `initSockets`. */
  abstract register(): void;

  /**
   * Bind a validated, rate-limited listener. `schema` parses the first argument (the payload); the
   * (optional) second argument is treated as a Socket.IO ack callback. A parse failure or rate-limit
   * trip acks `{ ok:false, error }` when an ack is present and otherwise silently drops — it never
   * throws into the socket runtime.
   */
  protected on<T>(
    event: string,
    schema: ZodType<T>,
    handler: (payload: T, ack?: (response: unknown) => void) => void | Promise<void>,
  ): void {
    this.socket.on(event, (raw: unknown, ack?: (response: unknown) => void) => {
      if (!this.allow(event)) {
        if (typeof ack === 'function') ack({ ok: false, error: 'rate_limited' });
        return;
      }
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        logger.debug('socket payload rejected', { event, userId: this.userId });
        if (typeof ack === 'function') ack({ ok: false, error: 'invalid_payload' });
        return;
      }
      void this.runHandler(event, handler, parsed.data, ack);
    });
  }

  private async runHandler<T>(
    event: string,
    handler: (payload: T, ack?: (response: unknown) => void) => void | Promise<void>,
    payload: T,
    ack?: (response: unknown) => void,
  ): Promise<void> {
    try {
      await handler(payload, ack);
    } catch (error) {
      Sentry.captureException(error);
      logger.error('socket handler error', {
        event,
        userId: this.userId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (typeof ack === 'function') ack({ ok: false, error: 'internal_error' });
    }
  }

  /** Register a side effect to run when the socket disconnects (rooms, timers, presence). */
  protected onCleanup(fn: () => void | Promise<void>): void {
    this.cleanups.push(fn);
  }

  /** Drain the cleanup registry. Called by `initSockets` on the socket's `disconnect`. */
  async cleanup(): Promise<void> {
    for (const fn of this.cleanups) {
      try {
        await fn();
      } catch (error) {
        Sentry.captureException(error);
        logger.error('socket cleanup error', {
          userId: this.userId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** Rolling token bucket, keyed per event. Returns false when the socket is over budget. */
  private allow(event: string): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(event);
    if (bucket === undefined || now >= bucket.resetAt) {
      this.buckets.set(event, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
      return true;
    }
    if (bucket.count >= RATE_LIMIT_MAX_EVENTS) {
      return false;
    }
    bucket.count += 1;
    return true;
  }
}
