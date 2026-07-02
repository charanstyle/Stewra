import type {
  Conversation,
  ConversationParticipant,
  ConversationType,
  ParticipantRole,
} from '@stewra/shared-types';
import type { Transaction } from 'kysely';
import { db } from '../database/index';
import type { Database } from '../database/types';

interface ConversationRow {
  readonly id: string;
  readonly type: ConversationType;
  readonly title: string | null;
  readonly avatar_url: string | null;
  readonly created_by: string;
  readonly last_message_at: Date;
  readonly is_archived: boolean;
  readonly created_at: Date;
}

interface ParticipantRow {
  readonly conversation_id: string;
  readonly user_id: string;
  readonly role: ParticipantRole;
  readonly is_muted: boolean;
  readonly last_read_at: Date | null;
  readonly joined_at: Date;
  readonly left_at: Date | null;
}

// Typed role literals so insert values type-check against the column without a type assertion.
const ADMIN: ParticipantRole = 'admin';
const MEMBER: ParticipantRole = 'member';

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    avatarUrl: row.avatar_url,
    createdBy: row.created_by,
    lastMessageAt: row.last_message_at.toISOString(),
    isArchived: row.is_archived,
    createdAt: row.created_at.toISOString(),
  };
}

function toParticipant(row: ParticipantRow): ConversationParticipant {
  return {
    conversationId: row.conversation_id,
    userId: row.user_id,
    role: row.role,
    isMuted: row.is_muted,
    lastReadAt: row.last_read_at ? row.last_read_at.toISOString() : null,
    joinedAt: row.joined_at.toISOString(),
    leftAt: row.left_at ? row.left_at.toISOString() : null,
  };
}

const CONVERSATION_COLUMNS = [
  'id',
  'type',
  'title',
  'avatar_url',
  'created_by',
  'last_message_at',
  'is_archived',
  'created_at',
] as const;

// Same columns, qualified for the join query in listForUser (explicit list keeps them fully typed).
const QUALIFIED_CONVERSATION_COLUMNS = [
  'conversations.id',
  'conversations.type',
  'conversations.title',
  'conversations.avatar_url',
  'conversations.created_by',
  'conversations.last_message_at',
  'conversations.is_archived',
  'conversations.created_at',
] as const;

const PARTICIPANT_COLUMNS = [
  'conversation_id',
  'user_id',
  'role',
  'is_muted',
  'last_read_at',
  'joined_at',
  'left_at',
] as const;

export class ConversationRepository {
  /**
   * Create a conversation and its participants in one transaction. The creator joins as `admin`, the
   * rest as `member`. `participantUserIds` should already be de-duplicated and exclude the creator.
   */
  async create(input: {
    type: ConversationType;
    title: string | null;
    createdBy: string;
    participantUserIds: ReadonlyArray<string>;
  }): Promise<Conversation> {
    return db.transaction().execute(async (trx) => {
      const conv = await trx
        .insertInto('conversations')
        .values({ type: input.type, title: input.title, created_by: input.createdBy })
        .returning(CONVERSATION_COLUMNS)
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('conversation_participants')
        .values([
          { conversation_id: conv.id, user_id: input.createdBy, role: ADMIN },
          ...input.participantUserIds.map((uid) => ({
            conversation_id: conv.id,
            user_id: uid,
            role: MEMBER,
          })),
        ])
        .execute();
      return toConversation(conv);
    });
  }

  async findById(id: string): Promise<Conversation | undefined> {
    const row = await db
      .selectFrom('conversations')
      .select(CONVERSATION_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? toConversation(row) : undefined;
  }

  /** The user's ACTIVE membership (left_at IS NULL) in a conversation — the authorization gate. */
  async getActiveParticipant(
    conversationId: string,
    userId: string,
  ): Promise<ConversationParticipant | undefined> {
    const row = await db
      .selectFrom('conversation_participants')
      .select(PARTICIPANT_COLUMNS)
      .where('conversation_id', '=', conversationId)
      .where('user_id', '=', userId)
      .where('left_at', 'is', null)
      .executeTakeFirst();
    return row ? toParticipant(row) : undefined;
  }

  /** All active participants of a conversation. */
  async listActiveParticipants(conversationId: string): Promise<ConversationParticipant[]> {
    const rows = await db
      .selectFrom('conversation_participants')
      .select(PARTICIPANT_COLUMNS)
      .where('conversation_id', '=', conversationId)
      .where('left_at', 'is', null)
      .execute();
    return rows.map(toParticipant);
  }

  /** The user's conversations (active membership), most-recently-active first. */
  async listForUser(userId: string): Promise<Conversation[]> {
    const rows = await db
      .selectFrom('conversations')
      .innerJoin(
        'conversation_participants',
        'conversation_participants.conversation_id',
        'conversations.id',
      )
      .select(QUALIFIED_CONVERSATION_COLUMNS)
      .where('conversation_participants.user_id', '=', userId)
      .where('conversation_participants.left_at', 'is', null)
      .orderBy('conversations.last_message_at', 'desc')
      .execute();
    return rows.map(toConversation);
  }

  /** Find the user's singleton Stewra-AI conversation, if it has been provisioned. */
  async findStewra(userId: string): Promise<Conversation | undefined> {
    const row = await db
      .selectFrom('conversations')
      .select(CONVERSATION_COLUMNS)
      .where('type', '=', 'stewra_ai')
      .where('created_by', '=', userId)
      .executeTakeFirst();
    return row ? toConversation(row) : undefined;
  }

  /**
   * Get-or-create the user's singleton Stewra-AI conversation. The DB's partial unique index makes the
   * insert the race arbiter: if a concurrent request already created it, our insert throws and we
   * re-fetch the winner rather than creating a duplicate.
   */
  async getOrCreateStewra(userId: string): Promise<Conversation> {
    const existing = await this.findStewra(userId);
    if (existing) return existing;
    try {
      return await db.transaction().execute(async (trx) => {
        const conv = await trx
          .insertInto('conversations')
          .values({ type: 'stewra_ai', title: null, created_by: userId })
          .returning(CONVERSATION_COLUMNS)
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('conversation_participants')
          .values({ conversation_id: conv.id, user_id: userId, role: ADMIN })
          .execute();
        return toConversation(conv);
      });
    } catch (error) {
      const raced = await this.findStewra(userId);
      if (raced) return raced;
      throw error;
    }
  }

  /** Add participants to a conversation (idempotent re-add clears a prior soft-leave). */
  async addParticipants(conversationId: string, userIds: ReadonlyArray<string>): Promise<void> {
    if (userIds.length === 0) return;
    await db
      .insertInto('conversation_participants')
      .values(
        userIds.map((uid) => ({
          conversation_id: conversationId,
          user_id: uid,
          role: MEMBER,
        })),
      )
      .onConflict((oc) => oc.columns(['conversation_id', 'user_id']).doUpdateSet({ left_at: null }))
      .execute();
  }

  /** Soft-leave: stamp left_at so history is preserved but the user is no longer a participant. */
  async leave(conversationId: string, userId: string): Promise<void> {
    await db
      .updateTable('conversation_participants')
      .set({ left_at: new Date() })
      .where('conversation_id', '=', conversationId)
      .where('user_id', '=', userId)
      .where('left_at', 'is', null)
      .execute();
  }

  /** Advance the user's read watermark. Returns the applied timestamp. */
  async markRead(conversationId: string, userId: string, at: Date): Promise<Date> {
    await db
      .updateTable('conversation_participants')
      .set({ last_read_at: at })
      .where('conversation_id', '=', conversationId)
      .where('user_id', '=', userId)
      .execute();
    return at;
  }

  /** Bump last_message_at (called when a message is sent). Accepts a transaction to stay atomic. */
  async touchLastMessage(
    conversationId: string,
    at: Date,
    trx: Transaction<Database>,
  ): Promise<void> {
    await trx
      .updateTable('conversations')
      .set({ last_message_at: at })
      .where('id', '=', conversationId)
      .execute();
  }
}

export const conversationRepository = new ConversationRepository();
