import type { ISODateString, UUID } from '../common/base';

/**
 * The kind of a message. `voice` is a spoken turn (carries a `transcript` + `audioUrl`); `audio` is a
 * plain voice note; `call_start`/`call_end` are system markers written into a conversation so call
 * history renders inline; `system` covers other non-user notices (participant added, etc.).
 */
export type MessageType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'voice'
  | 'call_start'
  | 'call_end'
  | 'system';
export const MESSAGE_TYPES: ReadonlyArray<MessageType> = [
  'text',
  'image',
  'video',
  'audio',
  'voice',
  'call_start',
  'call_end',
  'system',
];

/**
 * Who authored a message. `assistant` is the Stewra AI in a `stewra_ai` conversation — those messages
 * have `senderId = null` because the assistant is NOT a `users` row. Every human message is `user`.
 */
export type SenderKind = 'user' | 'assistant';

/** The fixed set of reactions a user can place on a message (WhatsApp/Zalo-style). */
export type ReactionType = 'like' | 'love' | 'haha' | 'wow' | 'sad' | 'angry';
export const REACTION_TYPES: ReadonlyArray<ReactionType> = [
  'like',
  'love',
  'haha',
  'wow',
  'sad',
  'angry',
];

/**
 * One message in a conversation. Human↔human and Stewra-AI messages share this shape; the Stewra-voice
 * extensions are `senderKind`, `audioUrl` (the TTS or voice-note clip), and `transcript` (STT text of a
 * spoken turn). Media messages carry `mediaUrl`/`mediaType`; call markers carry `callDurationSec`.
 */
export interface Message {
  readonly id: UUID;
  readonly conversationId: UUID;
  /** Null for assistant turns (the assistant is not a users row). */
  readonly senderId: UUID | null;
  readonly senderKind: SenderKind;
  readonly type: MessageType;
  readonly content: string | null;
  readonly mediaUrl: string | null;
  readonly mediaType: string | null;
  readonly mediaDurationSec: number | null;
  readonly thumbnailUrl: string | null;
  /** TTS output (assistant) or a recorded voice note (user); served via GET /media/:assetId. */
  readonly audioUrl: string | null;
  /** STT transcript of a spoken turn (`type='voice'`); the readable form of what was said. */
  readonly transcript: string | null;
  readonly replyToId: UUID | null;
  readonly isEdited: boolean;
  readonly isDeleted: boolean;
  /** Stamped when the message reaches an online recipient (or on their next join). Null until then. */
  readonly deliveredAt: ISODateString | null;
  readonly createdAt: ISODateString;
  readonly reactions: ReadonlyArray<MessageReaction>;
}

/** A compact last-message projection for conversation-list rows (no reactions/media payload). */
export interface MessagePreview {
  readonly id: UUID;
  readonly senderId: UUID | null;
  readonly type: MessageType;
  /** Short human-facing preview — the text, or a placeholder like "📷 Photo" / "🎤 Voice message". */
  readonly preview: string;
  readonly createdAt: ISODateString;
}

/** A single reaction placed by a user on a message. Unique per (message, user, reactionType). */
export interface MessageReaction {
  readonly messageId: UUID;
  readonly userId: UUID;
  readonly reactionType: ReactionType;
  readonly createdAt: ISODateString;
}

/** A read acknowledgement: `userId` has read up to and including `messageId`. */
export interface ReadReceipt {
  readonly messageId: UUID;
  readonly userId: UUID;
  readonly readAt: ISODateString;
}
