import type { ISODateString, UUID } from '../common/base';
import type { PublicUser } from './contact';
import type { MessagePreview } from './message';

/**
 * Kind of conversation. `direct` is 1:1 human↔human, `group` is many humans, `stewra_ai` is the
 * singleton conversation between a user and the Stewra assistant (the one place the AI speaks).
 */
export type ConversationType = 'direct' | 'group' | 'stewra_ai';
export const CONVERSATION_TYPES: ReadonlyArray<ConversationType> = ['direct', 'group', 'stewra_ai'];

/** A participant's role. `admin` can add/remove members and edit group metadata; `member` cannot. */
export type ParticipantRole = 'admin' | 'member';

/** Coarse online state broadcast to a user's contacts. Derived from live sockets + an idle timer. */
export type PresenceStatus = 'online' | 'away' | 'offline';

/** A conversation thread. `title`/`avatarUrl` are meaningful only for `group`. */
export interface Conversation {
  readonly id: UUID;
  readonly type: ConversationType;
  readonly title: string | null;
  readonly avatarUrl: string | null;
  readonly createdBy: UUID;
  readonly lastMessageAt: ISODateString;
  readonly isArchived: boolean;
  readonly createdAt: ISODateString;
}

/** Membership of one user in one conversation. `leftAt` non-null = a soft leave (row kept for history). */
export interface ConversationParticipant {
  readonly conversationId: UUID;
  readonly userId: UUID;
  readonly role: ParticipantRole;
  readonly isMuted: boolean;
  readonly lastReadAt: ISODateString | null;
  readonly joinedAt: ISODateString;
  readonly leftAt: ISODateString | null;
}

/** A conversation-list row: the conversation plus the derived data a list needs to render. */
export interface ConversationSummary {
  readonly conversation: Conversation;
  /** Public profiles of the OTHER active participants (excludes the requesting user). */
  readonly participants: ReadonlyArray<PublicUser>;
  readonly unreadCount: number;
  readonly lastMessage: MessagePreview | null;
}
