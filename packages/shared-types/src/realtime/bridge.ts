import type { BridgeWaState } from '../models/channel';

/**
 * The `/bridge` Socket.IO namespace: the wire between the Stewra Bridge app (running on the USER'S own
 * computer) and Stewra's servers.
 *
 * A bridge is NOT a user client, which is why it gets its own namespace rather than a role on the main
 * one. It must never join a chat room, appear in presence, or receive another user's traffic — and the
 * cheapest way to guarantee that is to give it a socket that has no access to any of those events in the
 * first place, instead of a shared socket guarded by checks somebody must remember to write.
 *
 * The bridge holds the WhatsApp connection. The server holds none. Everything below is therefore a
 * REPORT from the user's machine or an INSTRUCTION to it — never a WhatsApp operation performed by us.
 */

/** Events the BRIDGE sends to the server. */
export const BRIDGE_CLIENT_EVENTS = {
  /** First frame after connecting: identifies the build and its WhatsApp state, and drains the outbox. */
  HELLO: 'bridge:hello',
  /** The WhatsApp socket changed state — drives the live status dot in the web app. */
  STATE: 'bridge:state',
  /** A message arrived in a chat THE DEVICE HAS ALREADY DECIDED IS ALLOWED. */
  INBOUND: 'bridge:inbound',
  /** The authoritative set of chats the user has allowed. The device is the source of truth. */
  ALLOWED_CHATS: 'bridge:allowed-chats',
} as const;
export type BridgeClientEvent = (typeof BRIDGE_CLIENT_EVENTS)[keyof typeof BRIDGE_CLIENT_EVENTS];

/** Events the SERVER sends to a bridge. */
export const BRIDGE_SERVER_EVENTS = {
  /** Deliver this text to this chat. Acked with the provider message id the bridge got from WhatsApp. */
  SEND: 'bridge:send',
  /** The user revoked this device. The bridge must wipe its local WhatsApp credentials and shut down. */
  REVOKED: 'bridge:revoked',
} as const;
export type BridgeServerEvent = (typeof BRIDGE_SERVER_EVENTS)[keyof typeof BRIDGE_SERVER_EVENTS];

/** `bridge:hello` — the bridge announcing itself. */
export interface BridgeHelloPayload {
  readonly appVersion: string;
  readonly waState: BridgeWaState;
}

/** `bridge:state` — a WhatsApp connection-state transition. */
export interface BridgeStatePayload {
  readonly waState: BridgeWaState;
}

/**
 * `bridge:inbound` — one message, from a chat the DEVICE has already decided is allowed.
 *
 * The raw `jid` is included, and only for allowed chats. That is the whole privacy claim, and it is
 * checkable rather than merely promised: a chat the user has not allowed is filtered on their own
 * machine, so its JID and its contents never enter this payload and never reach our network at all.
 *
 * `isSelfChat` is load-bearing, not descriptive. Stewra answers ONLY the user's own "Message yourself"
 * chat. A message from a third party is stored (so Stewra can tell the user about it) and never, under
 * any circumstance, auto-replied to — see the server handler.
 */
export interface BridgeInboundPayload {
  /** Baileys `key.id`. Unique per chat, NOT globally — the server namespaces it by chat. */
  readonly providerMessageId: string;
  /** The chat's WhatsApp JID, e.g. `15550001111@s.whatsapp.net`. */
  readonly jid: string;
  readonly isSelfChat: boolean;
  /** True when the user themself sent it (Baileys `key.fromMe`). */
  readonly fromMe: boolean;
  /** The message text. Absent when the message was a voice note — then `audio` is present instead. */
  readonly text?: string;
  /**
   * A voice note (WhatsApp "push to talk" audio), decrypted on the user's own machine and carried here
   * so the server can transcribe it. Exactly one of `text` / `audio` is present. Other media (images,
   * files, non-PTT audio) is still dropped on the device.
   */
  readonly audio?: BridgeVoiceNote;
  readonly sentAt: string;
}

/** Audio bytes on the bridge wire — base64, with the container's MIME type. */
export interface BridgeVoiceNote {
  /** Base64 of the audio bytes as WhatsApp delivered them (normally OGG/Opus). */
  readonly data: string;
  /** MIME type without codec parameters, e.g. `audio/ogg`. */
  readonly mime: string;
  /** Duration WhatsApp reported, when it did. */
  readonly seconds?: number;
}

/** Bridges older than this strip `audio` from `bridge:send` and would deliver a voiced reply as text only. */
export const BRIDGE_VOICE_MIN_VERSION = '1.2.0';

/**
 * Bridges older than this strip `replyTo` from `bridge:send` and would deliver Stewra's line as a plain
 * message — indistinguishable, in the self-chat, from one the person sent themself.
 */
export const BRIDGE_REPLY_MIN_VERSION = '1.3.0';

/** One chat the user has allowed. */
export interface BridgeAllowedChat {
  readonly jid: string;
  readonly displayName: string;
  readonly isSelfChat: boolean;
}

/**
 * `bridge:allowed-chats` — the COMPLETE, authoritative allowlist as it stands on the device.
 *
 * The server replaces its set with this one, deleting any chat no longer present (and, by cascade, its
 * stored messages). Unticking a chat in the app therefore erases what we held for it, which is the only
 * honest meaning of "stop reading this chat".
 *
 * Never empty: the user's own self-chat is always allowed, so an empty list means a broken bridge rather
 * than a user choice — and the server rejects it rather than treating a bug as an instruction to delete
 * everything.
 */
export interface BridgeAllowedChatsPayload {
  readonly chats: readonly BridgeAllowedChat[];
}

/**
 * `bridge:send` — an outbound message the user has already approved.
 *
 * With `audio` present the bridge sends the bytes as a WhatsApp voice note (PTT) and `text` is the
 * spoken words, kept for the server's own records; without it, the bridge sends `text` as a message.
 * A voiced Stewra reply is therefore TWO sends — the note, then the text — never one frame doing both.
 *
 * `replyTo` is the Baileys `key.id` of the PERSON'S message this line answers. The bridge delivers the
 * line as a WhatsApp reply quoting it. In the self-chat every bubble is sent from the same account and
 * drawn the same way, so the quote is what makes Stewra's words and voice notes tellable from the
 * person's own. Absent only when there is nothing of theirs to quote.
 */
export interface BridgeSendPayload {
  readonly outboxId: string;
  readonly jid: string;
  readonly text: string;
  readonly audio?: BridgeVoiceNote;
  readonly replyTo?: string;
}

/** The bridge's ack to `bridge:send`. `providerMessageId` is what WhatsApp assigned the sent message. */
export interface BridgeSendAck {
  readonly ok: boolean;
  readonly providerMessageId?: string;
  readonly error?: string;
}
