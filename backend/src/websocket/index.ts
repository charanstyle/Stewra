import * as Sentry from '@sentry/node';
import { SERVER_EVENTS } from '@stewra/shared-types';
import type { PresenceUpdateEvent } from '@stewra/shared-types';
import { presenceService } from '../services/presenceService';
import { messageService } from '../services/messageService';
import { logger } from '../utils/logger';
import { attachRedisAdapter } from './socketAdapter';
import { setIo } from './emitter';
import { socketAuthMiddleware } from './socketAuthMiddleware';
import { PresenceHandler } from './presenceHandler';
import { ChatHandler } from './chatHandler';
import { CallSignalingHandler } from './callSignalingHandler';
import { config } from '../config/unifiedConfig';
import type { BaseSocketHandler } from './baseSocketHandler';
import type { AppServer, AppSocket } from './types';
import { presenceRoom, userRoom } from './types';

/** Broadcast a user's presence transition to everyone watching them (subscribers of `presence_{id}`). */
function broadcastPresence(io: AppServer, userId: string, online: boolean, lastActiveAt: string): void {
  const event: PresenceUpdateEvent = {
    userId,
    status: online ? 'online' : 'offline',
    lastActiveAt,
  };
  io.to(presenceRoom(userId)).emit(SERVER_EVENTS.PRESENCE_UPDATE, event);
}

/**
 * Install the realtime layer onto an already-created Socket.IO server: the Redis adapter (cross-instance
 * fan-out), the JWT handshake middleware, and — per connection — room membership, presence lifecycle,
 * and the feature handlers. Kept listener-free of the HTTP server itself: `index.ts` owns the
 * `http.Server` and calls this after `createApp()`, so `createApp()` stays supertest-friendly.
 *
 * Feature handlers (chat, calls, stewra-voice) are added to `buildHandlers` as later phases land; each
 * extends `BaseSocketHandler` (validation + rate-limit + cleanup) and is registered/cleaned up here.
 */
export function initSockets(io: AppServer): void {
  attachRedisAdapter(io);
  // Expose the server to the REST layer's notify bridge (controllers emit after a write commits).
  setIo(io);
  io.use(socketAuthMiddleware);

  // Heartbeat sweep: re-stamp this instance's live sockets so they stay inside the presence liveness
  // window. If the instance crashes or is redeployed, the sweep stops and its sockets age out of the
  // window on their own — that self-healing is what keeps a user from being pinned "online" forever
  // after an unclean disconnect. `unref` so the timer never keeps the process alive on shutdown.
  const heartbeat = setInterval(() => {
    const entries = [...io.of('/').sockets.values()].map((s) => ({
      userId: s.data.userId,
      socketId: s.id,
    }));
    presenceService.refresh(entries).catch((err: unknown) => {
      Sentry.captureException(err);
      logger.error('presence heartbeat sweep failed');
    });
  }, config.presence.refreshMs);
  heartbeat.unref();

  io.on('connection', (socket: AppSocket) => {
    const { userId } = socket.data;
    // Personal fan-out room: presence transitions, incoming messages/calls, and Stewra replies target it.
    void socket.join(userRoom(userId));

    const handlers: BaseSocketHandler[] = buildHandlers(io, socket);
    for (const handler of handlers) {
      handler.register();
    }

    // Mark online; only broadcast on a real offline→online transition (not on an extra tab).
    presenceService
      .connect(userId, socket.id)
      .then((becameOnline) => {
        if (becameOnline) broadcastPresence(io, userId, true, new Date().toISOString());
      })
      .catch((err: unknown) => {
        Sentry.captureException(err);
        logger.error('presence connect failed', { userId });
      });

    // Catch up delivery ticks — every message that arrived while this user was offline becomes delivered
    // now. Fire-and-forget; a failure just leaves the stamp for the recipient's next fetch to resolve.
    messageService.markPendingDeliveredOnConnect(userId).catch((err: unknown) => {
      Sentry.captureException(err);
      logger.error('delivered-on-connect failed', { userId });
    });

    socket.on('disconnect', () => {
      const at = new Date();
      Promise.all(handlers.map((h) => h.cleanup()))
        .then(() => presenceService.disconnect(userId, socket.id, at))
        .then((becameOffline) => {
          if (becameOffline) broadcastPresence(io, userId, false, at.toISOString());
        })
        .catch((err: unknown) => {
          Sentry.captureException(err);
          logger.error('presence disconnect failed', { userId });
        });
    });
  });

  logger.info('Socket.IO realtime layer initialized');
}

/** Construct the per-connection feature handlers. Extend as phases add chat / calls / stewra-voice. */
function buildHandlers(io: AppServer, socket: AppSocket): BaseSocketHandler[] {
  const handlers: BaseSocketHandler[] = [
    new PresenceHandler(io, socket),
    new ChatHandler(io, socket),
  ];
  // Calls signaling is only wired when the operator has enabled calling (a dev box without coturn/TURN
  // isn't blocked, and the /calls REST routes 503 in lockstep).
  if (config.calls.enabled) {
    handlers.push(new CallSignalingHandler(io, socket));
  }
  return handlers;
}
