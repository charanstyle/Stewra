import type { Paginated, UUID } from '../common/base';
import type { Message, ReactionType } from '../models/message';

/**
 * Send a text message. Media and voice go through dedicated multipart routes (POST /messages/media,
 * POST /messages/voice) rather than this JSON route. `clientId` is an optional client-generated id the
 * server echoes back so an optimistic UI can reconcile its pending bubble with the stored message.
 */
export interface SendMessageRequest {
  readonly conversationId: UUID;
  readonly type: 'text';
  readonly content: string;
  readonly replyToId?: UUID;
  readonly clientId?: string;
}
export interface SendMessageResponse {
  readonly message: Message;
}

/** Page a conversation's messages, newest-first, via an opaque cursor. */
export interface ListMessagesRequest {
  readonly conversationId: UUID;
  readonly cursor?: string;
  readonly limit?: number;
}
export interface ListMessagesResponse {
  readonly messages: Paginated<Message>;
}

/** Add or (with `remove: true`) retract a reaction on a message. */
export interface ReactRequest {
  readonly reactionType: ReactionType;
  readonly remove?: boolean;
}
export interface ReactResponse {
  readonly message: Message;
}

export interface DeleteMessageResponse {
  readonly messageId: UUID;
}

/**
 * Result of POST /messages/voice (multipart audio upload). Always returns the caller's transcribed
 * voice turn. For a `stewra_ai` conversation it ALSO returns the assistant's reply (text + TTS audio);
 * for a human conversation `assistantMessage` is null.
 */
export interface SendVoiceMessageResponse {
  readonly userMessage: Message;
  readonly assistantMessage: Message | null;
}

/** Result of POST /messages/media (multipart image/video/audio upload). */
export interface SendMediaMessageResponse {
  readonly message: Message;
}
