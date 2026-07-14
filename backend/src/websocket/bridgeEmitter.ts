import { z } from 'zod';
import { BRIDGE_SERVER_EVENTS } from '@stewra/shared-types';
import type { BridgeSendAck, BridgeSendPayload } from '@stewra/shared-types';
import type { BridgeNamespaceLike } from './bridgeTypes';
import { bridgeUserRoom } from './bridgeTypes';
import { logger } from '../utils/logger';

/** How long we wait for a bridge to confirm it actually put the message on WhatsApp. */
const SEND_ACK_TIMEOUT_MS = 20_000;

/**
 * The ack is a payload from a CLIENT — a desktop app on someone's machine that we do not control and
 * cannot vouch for. It is parsed, not asserted: a bridge that returns nonsense must produce a clean
 * failure, not a bad `provider_message_id` written into the database as though we trusted it.
 */
const sendAckSchema = z.object({
  ok: z.boolean(),
  providerMessageId: z.string().min(1).max(255).optional(),
  error: z.string().max(500).optional(),
});

let namespace: BridgeNamespaceLike | null = null;

/** Wired once at boot by `initSockets`, so services can reach the bridges without importing the server. */
export function setBridgeNamespace(ns: BridgeNamespaceLike): void {
  namespace = ns;
}

/**
 * Deliver a send to ONE of the user's online bridges and wait for it to confirm.
 *
 * Deliberately not a room broadcast. If a user runs both a desktop and a laptop, every bridge in the room
 * would send the same message and the recipient would see it twice — so we address a single device. A
 * duplicate WhatsApp message is not a cosmetic bug here: repeat sends are exactly the behaviour that gets
 * an account banned, which is the outcome this entire feature is trying not to cause.
 *
 * Returns null when no bridge is online. That is a NORMAL state (the laptop is shut), not an error: the
 * message stays queued in Postgres and the next `bridge:hello` drains it.
 */
export async function dispatchToBridge(
  userId: string,
  payload: BridgeSendPayload,
): Promise<{ deviceId: string; ack: BridgeSendAck } | null> {
  if (namespace === null) return null;

  const sockets = await namespace.in(bridgeUserRoom(userId)).fetchSockets();
  // A bridge without a device id never gets past `registerBridgeHandler`, so this only ever picks a real
  // one — but we must be able to NAME the machine we sent through, both for the outbox row and so the user
  // can revoke it, and so an anonymous socket is not an acceptable target even if one somehow existed.
  const target = sockets.find((s) => s.data.deviceId !== undefined);
  const deviceId = target?.data.deviceId;
  if (target === undefined || deviceId === undefined) return null;

  let raw: unknown;
  try {
    raw = await target.timeout(SEND_ACK_TIMEOUT_MS).emitWithAck(BRIDGE_SERVER_EVENTS.SEND, payload);
  } catch {
    // A timeout means the bridge never confirmed — but it may well have sent the message anyway. So we
    // do NOT retry: the outbox records a failed attempt and a visible error instead. Sending the same
    // message twice is worse than sending it late, both for the recipient and for the account.
    logger.warn('bridge: send ack timed out', { userId, deviceId, outboxId: payload.outboxId });
    return { deviceId, ack: { ok: false, error: 'ack_timeout' } };
  }

  const parsed = sendAckSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn('bridge: malformed send ack', { userId, deviceId, outboxId: payload.outboxId });
    return { deviceId, ack: { ok: false, error: 'malformed_ack' } };
  }

  // Rebuilt rather than passed through, so an absent field stays absent under exactOptionalPropertyTypes.
  const ack: BridgeSendAck = {
    ok: parsed.data.ok,
    ...(parsed.data.providerMessageId !== undefined
      ? { providerMessageId: parsed.data.providerMessageId }
      : {}),
    ...(parsed.data.error !== undefined ? { error: parsed.data.error } : {}),
  };
  return { deviceId, ack };
}

/**
 * Tell ONE revoked bridge to wipe its local WhatsApp session and stop, then cut it off.
 *
 * Targeted at the single revoked `deviceId`, never broadcast to the user's room. A user may run two
 * bridges; revoking the laptop must not make the desktop tear down its own WhatsApp session — the room is
 * keyed by user precisely so any bridge can drain the outbox, which makes it exactly the wrong handle for
 * an instruction that means "you, specifically, are no longer trusted".
 *
 * The disconnect is the part that actually enforces anything. The REVOKED event is a courtesy so the app
 * can clear its credentials and tell the user why it stopped; a bridge that ignores it still dies here,
 * and its token is already gone from the database, so it cannot reconnect.
 */
export async function notifyRevoked(userId: string, deviceId: string): Promise<void> {
  if (namespace === null) return;

  const sockets = await namespace.in(bridgeUserRoom(userId)).fetchSockets();
  for (const socket of sockets) {
    if (socket.data.deviceId !== deviceId) continue;
    socket.emit(BRIDGE_SERVER_EVENTS.REVOKED, {});
    socket.disconnect();
  }
}
