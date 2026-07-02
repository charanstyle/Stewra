import type { ISODateString, UUID } from '../common/base';
import type { Conversation, ConversationSummary, ConversationType } from '../models/conversation';

/**
 * Create a `direct` (exactly one other participant) or `group` (one or more) conversation. The
 * `stewra_ai` conversation is never created this way — it is provisioned server-side as a singleton
 * (see GET /conversations/stewra).
 */
export interface CreateConversationRequest {
  readonly type: Extract<ConversationType, 'direct' | 'group'>;
  readonly participantUserIds: ReadonlyArray<UUID>;
  readonly title?: string;
}
export interface CreateConversationResponse {
  readonly conversation: Conversation;
}

/** The caller's conversations, most-recent-first, each with unread count + last-message preview. */
export interface ListConversationsResponse {
  readonly conversations: ReadonlyArray<ConversationSummary>;
}

export interface GetConversationResponse {
  readonly conversation: ConversationSummary;
}

/** Fetch (provisioning on first call) the caller's singleton Stewra-AI conversation. */
export interface GetStewraConversationResponse {
  readonly conversation: ConversationSummary;
}

/** Add participants to a group conversation (admin only). */
export interface AddParticipantsRequest {
  readonly userIds: ReadonlyArray<UUID>;
}
export interface AddParticipantsResponse {
  readonly conversation: ConversationSummary;
}

export interface LeaveConversationResponse {
  readonly conversationId: UUID;
}

/** Mark the conversation read up to and including a message; returns the resulting read watermark. */
export interface MarkReadRequest {
  readonly upToMessageId: UUID;
}
export interface MarkReadResponse {
  readonly conversationId: UUID;
  readonly lastReadAt: ISODateString;
}
