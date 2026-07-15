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
});

const claimResponseSchema = z.object({
  data: z.object({
    token: z.string().min(1),
    device: z.object({ id: z.string(), name: z.string() }),
  }),
});

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

  /**
   * Trade the one-time pairing code from the web app for this device's long-lived token.
   *
   * Unauthenticated by design: the bridge has no user session and must never be given one. Handing a
   * desktop app the user's access token would hand it their whole Stewra account, when all it needs is
   * permission to relay messages — and permission the user can take back with one click.
   */
  async claimToken(code: string, deviceName: string): Promise<string> {
    const response = await fetch(`${this.config.apiBaseUrl}/api/channels/whatsapp-personal/bridge-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, deviceName, appVersion: this.config.appVersion }),
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

    socket.on('connect', () => this.events.onConnected());
    socket.on('disconnect', () => this.events.onDisconnected());

    socket.on(BRIDGE_SERVER_EVENTS.REVOKED, () => this.events.onRevoked());

    socket.on(BRIDGE_SERVER_EVENTS.SEND, (raw: unknown, ack?: (response: BridgeSendAck) => void) => {
      if (ack === undefined) return;
      const parsed = sendPayloadSchema.safeParse(raw);
      if (!parsed.success) {
        ack({ ok: false, error: 'malformed_send' });
        return;
      }
      void this.events
        .onSend(parsed.data)
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
    this.socket?.emit(BRIDGE_CLIENT_EVENTS.INBOUND, payload);
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
