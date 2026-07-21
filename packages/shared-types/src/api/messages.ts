import type { Paginated, UUID } from '../common/base';
import type { Message, ReactionType, ReadReceipt } from '../models/message';

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

/**
 * Per-participant read acknowledgements for one message (GET /messages/:id/receipts), powering the
 * read-receipt detail view. Ordered by `readAt`; excludes the message's own sender.
 */
export interface ListReadReceiptsResponse {
  readonly receipts: ReadonlyArray<ReadReceipt>;
}

/** Resolve a Stewra-proposed email: `send` executes the confirm-gated send, `cancel` dismisses it. */
export type ConfirmEmailAction = 'send' | 'cancel';

/**
 * One message by id (GET /messages/:id), for a viewer who participates in its conversation.
 *
 * Exists for the approve-to-send flow: the approval notification carries only a `messageId` (never the
 * email's contents, which must not sit in an OS notification), so the app fetches the draft over its
 * authenticated session to show the user WHAT they are approving. Approving an email you cannot see is
 * a blind signature, which would defeat the point of asking.
 */
export interface GetMessageResponse {
  readonly message: Message;
}

/**
 * Confirm (or dismiss) the email Stewra proposed on an assistant message
 * (POST /messages/:id/confirm-email). The stored message's `proposedEmail.status` transitions to
 * `sent`/`failed` (on `send`) or `cancelled` (on `cancel`); the updated message is returned so the
 * card re-renders in its terminal state, and is also pushed to the room over the chat socket.
 */
export interface ConfirmEmailRequest {
  readonly action: ConfirmEmailAction;
}
export interface ConfirmEmailResponse {
  readonly message: Message;
}

/** Resolve a Stewra-proposed runner session: `start` kicks it off, `cancel` dismisses it. */
export type ConfirmRunnerSessionAction = 'start' | 'cancel';

/**
 * Confirm (or dismiss) the coding-agent runner session Stewra proposed on an assistant message
 * (POST /messages/:id/confirm-runner-session). This is the button-driven twin of the natural-language
 * "yes"/"no" confirm loop (web/mobile render Start/Cancel over the same path). On `start` the stored
 * message's `proposedRunnerSession.status` transitions to `sent` (with the new `sessionId`) or `failed`;
 * on `cancel` to `cancelled`. The updated message is returned so the card re-renders and is pushed to
 * the room over the chat socket.
 */
export interface ConfirmRunnerSessionRequest {
  readonly action: ConfirmRunnerSessionAction;
}
export interface ConfirmRunnerSessionResponse {
  readonly message: Message;
}
