import * as Sentry from '@sentry/node';
import { z } from 'zod';
import { BRIDGE_CLIENT_EVENTS, BRIDGE_WA_STATES } from '@stewra/shared-types';
import { whatsappBridgeService } from '../services/whatsappBridgeService.js';
import { logger } from '../utils/logger.js';
import { bridgeUserRoom } from './bridgeTypes.js';
import type { BridgeSocketLike } from './bridgeTypes.js';

/**
 * Every payload below arrives from a desktop app on someone else's machine. It is parsed, never trusted:
 * a bridge could be old, buggy, or tampered with, and none of those may be able to corrupt what we store.
 */
const waStateSchema = z.enum(BRIDGE_WA_STATES);

const helloSchema = z.object({
  appVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  waState: waStateSchema,
});

const stateSchema = z.object({ waState: waStateSchema });

const inboundSchema = z.object({
  providerMessageId: z.string().min(1).max(255),
  jid: z.string().min(1).max(128),
  isSelfChat: z.boolean(),
  fromMe: z.boolean(),
  // Bounded: WhatsApp's own cap is 4096, and an unbounded body from a client is a storage-abuse vector.
  text: z.string().min(1).max(8192),
  sentAt: z.string().datetime(),
});

const allowedChatsSchema = z.object({
  // NEVER empty. The self-chat is always allowed, so an empty list is a broken bridge — and a bug must
  // not be executed as an instruction to delete everything the user allowed.
  chats: z
    .array(
      z.object({
        jid: z.string().min(1).max(128),
        displayName: z.string().max(128),
        isSelfChat: z.boolean(),
      }),
    )
    .min(1)
    .max(500),
});

/**
 * Wire up one connected Stewra Bridge.
 *
 * This is intentionally NOT a `BaseSocketHandler`. That base class exists for user clients and gives them
 * a per-socket event budget of 60 events / 10s — which is right for a person typing, and wrong for a
 * bridge draining a backlog after a laptop has been shut for a day. More importantly, a bridge must never
 * inherit the ability to join a conversation room or emit chat events, and the surest way to guarantee
 * that is to not hand it the machinery in the first place.
 *
 * What bounds a bridge instead is the thing that actually matters: the per-user SEND budget in
 * `whatsappBridgeService`, because outbound volume is what gets a WhatsApp account banned. Inbound events
 * cost us a database write and are already deduped.
 */
export function registerBridgeHandler(socket: BridgeSocketLike): void {
  const { userId, deviceId } = socket.data;

  // The door check. `bridgeAuthMiddleware` sets `deviceId` on every socket that gets this far, so this can
  // only fire if something is wired wrong — and a bridge whose device we cannot name is a bridge we cannot
  // revoke. It gets no events, not the benefit of the doubt.
  if (deviceId === undefined) {
    logger.error('bridge: connection without a device id; refusing', { userId, socketId: socket.id });
    socket.disconnect();
    return;
  }

  // Joined so a queued send can find whichever of the user's machines happens to be awake.
  void socket.join(bridgeUserRoom(userId));

  /** Run a handler, capturing anything it throws — a bad frame must never take the connection down. */
  const guard = (event: string, fn: () => Promise<void>): void => {
    void fn().catch((error: unknown) => {
      Sentry.captureException(error);
      logger.error('bridge handler error', {
        event,
        userId,
        deviceId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  socket.on(BRIDGE_CLIENT_EVENTS.HELLO, (raw: unknown) => {
    const parsed = helloSchema.safeParse(raw);
    if (!parsed.success) return;
    logger.info('bridge: hello', { userId, deviceId, ...parsed.data });
    guard(BRIDGE_CLIENT_EVENTS.HELLO, () =>
      whatsappBridgeService.onBridgeOnline(userId, deviceId, parsed.data.waState),
    );
  });

  socket.on(BRIDGE_CLIENT_EVENTS.STATE, (raw: unknown) => {
    const parsed = stateSchema.safeParse(raw);
    if (!parsed.success) return;
    guard(BRIDGE_CLIENT_EVENTS.STATE, () =>
      whatsappBridgeService.onStateChange(deviceId, parsed.data.waState),
    );
  });

  socket.on(BRIDGE_CLIENT_EVENTS.ALLOWED_CHATS, (raw: unknown) => {
    const parsed = allowedChatsSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn('bridge: rejected an invalid allowlist', { userId, deviceId });
      return;
    }
    guard(BRIDGE_CLIENT_EVENTS.ALLOWED_CHATS, () =>
      whatsappBridgeService.onAllowedChats(userId, parsed.data.chats),
    );
  });

  socket.on(BRIDGE_CLIENT_EVENTS.INBOUND, (raw: unknown) => {
    const parsed = inboundSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn('bridge: rejected a malformed inbound message', { userId, deviceId });
      return;
    }
    guard(BRIDGE_CLIENT_EVENTS.INBOUND, () => whatsappBridgeService.onInbound(userId, parsed.data));
  });

  socket.on('disconnect', () => {
    // The bridge going away is normal — a closed laptop, not a failure. Mark it so the web app's status
    // dot tells the truth: Stewra cannot answer on WhatsApp right now.
    guard('disconnect', () => whatsappBridgeService.onStateChange(deviceId, 'disconnected'));
  });
}
