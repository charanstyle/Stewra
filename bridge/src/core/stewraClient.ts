import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import {
  BRIDGE_CLIENT_EVENTS,
  BRIDGE_SERVER_EVENTS,
} from '@stewra/shared-types';
import type {
  BridgeAllowedChat,
  BridgeInboundPayload,
  BridgeSendAck,
  BridgeSendPayload,
  BridgeWaState,
} from '@stewra/shared-types';
import { z } from 'zod';
import type { BridgeConfig } from './config.js';

/** The server's send instruction, parsed. It is trusted only after this passes. */
const sendPayloadSchema = z.object({
  outboxId: z.string().min(1),
  jid: z.string().min(1),
  text: z.string().min(1),
  // Present ⇒ deliver as a voice note. The mime is pinned: the bridge always sends OGG/Opus PTT, and
  // accepting anything else here would be promising a format WhatsApp would not play as a voice note.
  audio: z
    .object({
      data: z.string().min(1),
      mime: z.literal('audio/ogg'),
      seconds: z.number().positive().optional(),
    })
    .optional(),
  // Present ⇒ deliver as a WhatsApp reply quoting this message of the person's (its Baileys `key.id`).
  replyTo: z.string().min(1).optional(),
});

const claimResponseSchema = z.object({
  data: z.object({
    token: z.string().min(1),
    device: z.object({ id: z.string(), name: z.string() }),
  }),
});

/**
 * Trade the one-time pairing code from the web app for this device's long-lived token.
 *
 * Unauthenticated by design: the bridge has no user session and must never be given one. Handing a
 * desktop app the user's access token would hand it their whole Stewra account, when all it needs is
 * permission to relay messages — and permission the user can take back with one click.
 *
 * A free function, not a method: pairing happens before any Bridge exists, and needing to construct
 * a whole Bridge (WhatsApp client and all) just to make one REST call invited exactly that.
 */
export async function claimBridgeToken(config: BridgeConfig, code: string, deviceName: string): Promise<string> {
  const response = await fetch(`${config.apiBaseUrl}/api/channels/whatsapp-personal/bridge-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, deviceName, appVersion: config.appVersion }),
    // Without this, a hung connection leaves the pairing UI on "Linking…" forever with no error.
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message =
      typeof body === 'object' && body !== null && typeof Reflect.get(body, 'message') === 'string'
        ? String(Reflect.get(body, 'message'))
        : 'Stewra rejected that pairing code.';
    throw new Error(message);
  }

  const parsed = claimResponseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('Stewra returned a response this bridge did not understand.');
  return parsed.data.data.token;
}

export interface StewraClientEvents {
  /** The server asked us to send a message on WhatsApp. Returns what actually happened. */
  onSend(payload: BridgeSendPayload): Promise<BridgeSendAck>;
  /** The user revoked THIS device from the web app. Wipe the WhatsApp session and stop. */
  onRevoked(): void;
  onConnected(): void;
  onDisconnected(): void;
}

/**
 * The bridge's link to Stewra.
 *
 * Note what this client never sends: no WhatsApp credentials, no chat list, no message from a chat the
 * user did not tick. The allowlist gate runs before anything reaches this file, which is why the promise
 * "Stewra's servers never learn a chat exists unless you tick it" is a fact about the code rather than an
 * assurance in a privacy policy.
 */
export class StewraClient {
  private socket: Socket | null = null;

  constructor(
    private readonly config: BridgeConfig,
    private readonly events: StewraClientEvents,
  ) {}

  /** Open the `/bridge` namespace with this device's token. Reconnection is Socket.IO's problem. */
  connect(token: string): void {
    const socket = io(`${this.config.apiBaseUrl}/bridge`, {
      // Stewra's public surface mounts the backend under `/api` (this file's REST calls already assume
      // it). The Socket.IO engine rides the same prefix; the default `/socket.io` path would hit the
      // website, not the backend.
      path: '/api/socket.io',
      auth: { token },
      transports: ['websocket'],
    });
    this.socket = socket;

    socket.on('connect', () => {
      console.error('Stewra Bridge: connected to Stewra.');
      this.events.onConnected();
    });
    socket.on('disconnect', (reason) => {
      console.error(`Stewra Bridge: disconnected from Stewra (${reason}).`);
      this.events.onDisconnected();
    });
    // Without this, a rejected bridge token (or an unreachable server) retries forever with nothing on
    // screen and no log — the message loop would look dead for a reason nobody could see.
    socket.on('connect_error', (error: Error) => {
      console.error('Stewra Bridge: could not connect to Stewra:', error.message);
    });

    socket.on(BRIDGE_SERVER_EVENTS.REVOKED, () => this.events.onRevoked());

    socket.on(BRIDGE_SERVER_EVENTS.SEND, (raw: unknown, ack?: (response: BridgeSendAck) => void) => {
      if (ack === undefined) return;
      const parsed = sendPayloadSchema.safeParse(raw);
      if (!parsed.success) {
        ack({ ok: false, error: 'malformed_send' });
        return;
      }
      const { outboxId, jid, text, audio, replyTo } = parsed.data;
      // Rebuilt field by field, so an absent option stays absent under exactOptionalPropertyTypes.
      const payload: BridgeSendPayload = {
        outboxId,
        jid,
        text,
        ...(audio === undefined
          ? {}
          : {
              audio: {
                data: audio.data,
                mime: audio.mime,
                ...(audio.seconds !== undefined ? { seconds: audio.seconds } : {}),
              },
            }),
        ...(replyTo === undefined ? {} : { replyTo }),
      };
      void this.events
        .onSend(payload)
        .then(ack)
        .catch((error: unknown) => {
          ack({ ok: false, error: error instanceof Error ? error.message : 'send_failed' });
        });
    });
  }

  hello(waState: BridgeWaState): void {
    this.socket?.emit(BRIDGE_CLIENT_EVENTS.HELLO, {
      appVersion: this.config.appVersion,
      waState,
    });
  }

  state(waState: BridgeWaState): void {
    this.socket?.emit(BRIDGE_CLIENT_EVENTS.STATE, { waState });
  }

  inbound(payload: BridgeInboundPayload): void {
    if (this.socket === null || this.socket.connected !== true) {
      console.error(
        'Stewra Bridge: a message was ready to forward but the Stewra socket is down; it was not sent.',
      );
      return;
    }
    console.error(`Stewra Bridge: → bridge:inbound (${payload.jid}, selfChat=${payload.isSelfChat}).`);
    this.socket.emit(BRIDGE_CLIENT_EVENTS.INBOUND, payload);
  }

  /** The ticked chats. Never called with an empty list — the server refuses one, and rightly. */
  allowedChats(chats: readonly BridgeAllowedChat[]): void {
    if (chats.length === 0) return;
    this.socket?.emit(BRIDGE_CLIENT_EVENTS.ALLOWED_CHATS, { chats });
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
  }
}
