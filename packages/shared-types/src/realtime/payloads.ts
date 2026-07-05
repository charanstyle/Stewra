import type { ISODateString, UUID } from '../common/base';
import type { ContactInviteWithUsers, ContactWithUser } from '../models/contact';
import type { PresenceStatus } from '../models/conversation';
import type { Message, MessageReaction, ReadReceipt } from '../models/message';
import type { CallEndReason, CallKind, RtcIceCandidate, RtcSessionDescription } from '../models/call';

/**
 * Strict payload shapes for every Socket.IO event in `events.ts`. The server Zod-validates each inbound
 * payload against these; no `any`, no loose `Record`. Names read as `<Domain><Thing>Payload` for
 * client→server and `<Domain><Thing>Event` for server→client.
 */

// ── presence ────────────────────────────────────────────────────────────────
/** Client → server: watch presence for a set of users (typically the caller's contacts). */
export interface PresenceSubscribePayload {
  readonly userIds: ReadonlyArray<UUID>;
}
export interface PresenceUpdateEvent {
  readonly userId: UUID;
  readonly status: PresenceStatus;
  readonly lastActiveAt: ISODateString;
}

// ── contacts: server → client (personal-room notifications) ───────────────────
/**
 * Pushed to the invitee's room the moment someone invites them, carrying the fully-hydrated invite so
 * the client can show "<inviter> invited you" live and drop it into the pending list without a refetch.
 */
export interface ContactInviteReceivedEvent {
  readonly invite: ContactInviteWithUsers;
}
/**
 * Pushed to the inviter's room when their invitee accepts. Carries the new contact from the inviter's
 * side (`contact.user` is the person who accepted), so the UI can say "<name> accepted — say hi" and add
 * them to the contact list immediately.
 */
export interface ContactInviteAcceptedEvent {
  readonly contact: ContactWithUser;
}

// ── chat: client → server (ephemeral) ─────────────────────────────────────────
export interface ChatJoinPayload {
  readonly conversationId: UUID;
}
export interface ChatTypingPayload {
  readonly conversationId: UUID;
  readonly isTyping: boolean;
}
export interface ChatMarkReadPayload {
  readonly conversationId: UUID;
  readonly upToMessageId: UUID;
}

// ── chat: server → client ─────────────────────────────────────────────────────
export interface ChatMessageEvent {
  readonly message: Message;
}
export interface ChatDeliveredEvent {
  readonly conversationId: UUID;
  readonly messageId: UUID;
  readonly userId: UUID;
  readonly deliveredAt: ISODateString;
}
export interface ChatReadEvent {
  readonly conversationId: UUID;
  readonly receipts: ReadonlyArray<ReadReceipt>;
}
export interface ChatTypingEvent {
  readonly conversationId: UUID;
  readonly userId: UUID;
  readonly isTyping: boolean;
}
export interface ChatReactionEvent {
  readonly reaction: MessageReaction;
  readonly removed: boolean;
}

// ── calls: client → server ────────────────────────────────────────────────────
export interface CallInitiatePayload {
  readonly conversationId: UUID;
  readonly callType: CallKind;
}
/** Answer/decline/end all identify a call by id. */
export interface CallLifecyclePayload {
  readonly callId: UUID;
}
/** An SDP offer or answer to relay to the other party. */
export interface CallSignalPayload {
  readonly callId: UUID;
  readonly description: RtcSessionDescription;
}
export interface CallIcePayload {
  readonly callId: UUID;
  readonly candidate: RtcIceCandidate;
}

// ── calls: server → client ────────────────────────────────────────────────────
export interface CallIncomingEvent {
  readonly callId: UUID;
  readonly conversationId: UUID;
  readonly fromUserId: UUID;
  readonly callType: CallKind;
}
export interface CallAnsweredEvent {
  readonly callId: UUID;
  readonly byUserId: UUID;
}
export interface CallDeclinedEvent {
  readonly callId: UUID;
  readonly byUserId: UUID;
}
export interface CallEndedEvent {
  readonly callId: UUID;
  readonly reason: CallEndReason;
}
export interface CallRemoteOfferEvent {
  readonly callId: UUID;
  readonly fromUserId: UUID;
  readonly description: RtcSessionDescription;
}
export interface CallRemoteAnswerEvent {
  readonly callId: UUID;
  readonly fromUserId: UUID;
  readonly description: RtcSessionDescription;
}
export interface CallRemoteIceEvent {
  readonly callId: UUID;
  readonly fromUserId: UUID;
  readonly candidate: RtcIceCandidate;
}
export interface CallErrorEvent {
  readonly callId: UUID | null;
  readonly message: string;
}

// ── stewra-voice: server → client ─────────────────────────────────────────────
/** The assistant is composing a reply (drives a "thinking…" indicator). */
export interface StewraThinkingEvent {
  readonly conversationId: UUID;
}
/** The assistant's completed reply (text + optional TTS audio), delivered as one message. */
export interface StewraReplyEvent {
  readonly message: Message;
}
/** Reserved: an incremental token delta for the future streaming path. Unused in v1. */
export interface StewraReplyChunkEvent {
  readonly conversationId: UUID;
  readonly delta: string;
}
/** The assistant turn could not be produced (model/TTS failure); clears "thinking" and shows a notice. */
export interface StewraErrorEvent {
  readonly conversationId: UUID;
  readonly message: string;
}
