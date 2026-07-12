import type {
  Message,
  MessageReaction,
  MessagePreview,
  MessageStatus,
  MessageType,
  ProposedActionStatus,
  ProposedEmail,
  ReactionType,
  ReadReceipt,
  SenderKind,
} from '@stewra/shared-types';
import { PROPOSED_ACTION_STATUSES } from '@stewra/shared-types';
import { db } from '../database/index';
import type { JsonMetadata, JsonValue } from '../database/types';
import { conversationRepository } from './conversationRepository';

interface MessageRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly sender_id: string | null;
  readonly sender_kind: SenderKind;
  readonly message_type: MessageType;
  readonly content: string | null;
  readonly media_url: string | null;
  readonly media_type: string | null;
  readonly media_duration_sec: number | null;
  readonly thumbnail_url: string | null;
  readonly audio_url: string | null;
  readonly transcript: string | null;
  readonly metadata: JsonMetadata;
  readonly reply_to_message_id: string | null;
  readonly is_edited: boolean;
  readonly is_deleted: boolean;
  readonly delivered_at: Date | null;
  readonly created_at: Date;
}

interface ReactionRow {
  readonly message_id: string;
  readonly user_id: string;
  readonly reaction_type: ReactionType;
  readonly created_at: Date;
}

interface ReceiptRow {
  readonly message_id: string;
  readonly user_id: string;
  readonly read_at: Date;
}

const MESSAGE_COLUMNS = [
  'id',
  'conversation_id',
  'sender_id',
  'sender_kind',
  'message_type',
  'content',
  'media_url',
  'media_type',
  'media_duration_sec',
  'thumbnail_url',
  'audio_url',
  'transcript',
  'metadata',
  'reply_to_message_id',
  'is_edited',
  'is_deleted',
  'delivered_at',
  'created_at',
] as const;

const REACTION_COLUMNS = ['message_id', 'user_id', 'reaction_type', 'created_at'] as const;

const RECEIPT_COLUMNS = ['message_id', 'user_id', 'read_at'] as const;

function toReaction(row: ReactionRow): MessageReaction {
  return {
    messageId: row.message_id,
    userId: row.user_id,
    reactionType: row.reaction_type,
    createdAt: row.created_at.toISOString(),
  };
}

function toReceipt(row: ReceiptRow): ReadReceipt {
  return {
    messageId: row.message_id,
    userId: row.user_id,
    readAt: row.read_at.toISOString(),
  };
}

/**
 * The sender-facing delivery status, derived from delivery + read facts. Only the caller's OWN messages
 * carry a meaningful tick (others' messages always read `sent`, since the recipient never shows ticks on
 * incoming bubbles). For an own message: any read receipt (necessarily from another participant) → `read`;
 * else a delivery stamp → `delivered`; else `sent`.
 */
function deriveStatus(
  row: MessageRow,
  receipts: ReadonlyArray<ReadReceipt>,
  viewerId: string,
): MessageStatus {
  if (row.sender_id === null || row.sender_id !== viewerId) return 'sent';
  if (receipts.length > 0) return 'read';
  if (row.delivered_at !== null) return 'delivered';
  return 'sent';
}

/** A non-null, non-array JSON object (the branch of JsonValue with string-keyed members). */
function isJsonObject(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrow a raw string to the `ProposedActionStatus` union without a type assertion. */
function isProposedActionStatus(value: string): value is ProposedActionStatus {
  return PROPOSED_ACTION_STATUSES.some((status) => status === value);
}

/**
 * Recover a `ProposedEmail` from a message's `metadata` jsonb bag (stored under the `proposedEmail`
 * key by the compose/confirm paths). Defensive: any missing/malformed shape yields null so a message
 * with unrelated metadata (e.g. a call marker's `call_id`) is simply treated as having no proposal.
 */
function parseProposedEmail(metadata: JsonMetadata | null | undefined): ProposedEmail | null {
  const raw = metadata?.['proposedEmail'];
  if (!isJsonObject(raw)) {
    return null;
  }
  const { status, to, subject, body, provider, failureReason } = raw;
  if (
    typeof status !== 'string' ||
    typeof to !== 'string' ||
    typeof subject !== 'string' ||
    typeof body !== 'string' ||
    !isProposedActionStatus(status)
  ) {
    return null;
  }
  return {
    status,
    to,
    subject,
    body,
    provider: typeof provider === 'string' ? provider : null,
    failureReason: typeof failureReason === 'string' ? failureReason : null,
  };
}

function toMessage(
  row: MessageRow,
  reactions: ReadonlyArray<MessageReaction>,
  receipts: ReadonlyArray<ReadReceipt>,
  viewerId: string,
): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    senderKind: row.sender_kind,
    type: row.message_type,
    content: row.content,
    mediaUrl: row.media_url,
    mediaType: row.media_type,
    mediaDurationSec: row.media_duration_sec,
    thumbnailUrl: row.thumbnail_url,
    audioUrl: row.audio_url,
    transcript: row.transcript,
    replyToId: row.reply_to_message_id,
    isEdited: row.is_edited,
    isDeleted: row.is_deleted,
    deliveredAt: row.delivered_at ? row.delivered_at.toISOString() : null,
    status: deriveStatus(row, receipts, viewerId),
    readReceipts: receipts,
    createdAt: row.created_at.toISOString(),
    reactions,
    proposedEmail: parseProposedEmail(row.metadata),
  };
}

/** Short human-facing preview text for a conversation-list row (never the full media payload). */
function previewText(row: MessageRow): string {
  if (row.is_deleted) return 'Message deleted';
  switch (row.message_type) {
    case 'image':
      return '📷 Photo';
    case 'video':
      return '🎥 Video';
    case 'audio':
      return '🎵 Audio';
    case 'voice':
      return row.transcript && row.transcript.length > 0 ? row.transcript : '🎤 Voice message';
    case 'call_start':
      return row.media_type === 'video' ? '📹 Video call started' : '📞 Voice call started';
    case 'call_end':
      return row.media_type === 'video' ? '📹 Video call ended' : '📞 Voice call ended';
    default:
      return row.content ?? '';
  }
}

/** Opaque keyset cursor over (created_at, id) so pagination is stable under inserts. */
function encodeCursor(row: { created_at: Date; id: string }): string {
  return Buffer.from(`${row.created_at.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}
function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const sep = decoded.lastIndexOf('|');
  if (sep < 0) return null;
  const iso = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime()) || id.length === 0) return null;
  return { createdAt, id };
}

// Typed literals so insert values type-check against the column without a type assertion.
const SENDER_USER: SenderKind = 'user';

/** One "delivered on connect" notification: a message freshly stamped delivered, addressed to its sender. */
export interface PendingDelivery {
  readonly messageId: string;
  readonly conversationId: string;
  readonly senderId: string;
  readonly deliveredAt: string;
}

export interface NewMessage {
  readonly conversationId: string;
  readonly senderId: string | null;
  readonly senderKind: SenderKind;
  readonly type: MessageType;
  readonly content: string | null;
  readonly mediaUrl?: string | null;
  readonly mediaType?: string | null;
  readonly mediaDurationSec?: number | null;
  readonly thumbnailUrl?: string | null;
  readonly audioUrl?: string | null;
  readonly transcript?: string | null;
  readonly replyToId?: string | null;
  /** A Stewra-proposed email to attach to this (assistant) message; stored in the `metadata` bag. */
  readonly proposedEmail?: ProposedEmail | null;
}

/** Serialize a proposal into the jsonb `metadata` insert/update string, or `undefined` for none. */
function serializeMetadata(proposedEmail: ProposedEmail | null | undefined): string | undefined {
  return proposedEmail ? JSON.stringify({ proposedEmail }) : undefined;
}

export class MessageRepository {
  /**
   * Insert a message and bump the conversation's last_message_at in ONE transaction (so the inbox sort
   * key can never drift from the actual latest message). Returns the stored message (reactions empty).
   */
  async create(input: NewMessage): Promise<Message> {
    return db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto('messages')
        .values({
          conversation_id: input.conversationId,
          sender_id: input.senderId,
          sender_kind: input.senderKind,
          message_type: input.type,
          content: input.content,
          media_url: input.mediaUrl ?? null,
          media_type: input.mediaType ?? null,
          media_duration_sec: input.mediaDurationSec ?? null,
          thumbnail_url: input.thumbnailUrl ?? null,
          audio_url: input.audioUrl ?? null,
          transcript: input.transcript ?? null,
          metadata: serializeMetadata(input.proposedEmail),
          reply_to_message_id: input.replyToId ?? null,
        })
        .returning(MESSAGE_COLUMNS)
        .executeTakeFirstOrThrow();
      await conversationRepository.touchLastMessage(input.conversationId, row.created_at, trx);
      // A freshly-created message has no receipts yet; the sender is the viewer, so status resolves to
      // `sent` (or `delivered` once markDeliveredToOnline stamps it and re-emits).
      return toMessage(row, [], [], input.senderId ?? '');
    });
  }

  /**
   * Replace the proposed-email payload in a message's `metadata` bag (the confirm-gated executor's
   * pending→sent/failed/cancelled transition). Overwrites the whole bag with the new proposal — a
   * proposal-bearing assistant message carries no other metadata, so nothing is lost.
   */
  async updateProposedEmail(messageId: string, proposedEmail: ProposedEmail): Promise<void> {
    await db
      .updateTable('messages')
      .set({ metadata: JSON.stringify({ proposedEmail }) })
      .where('id', '=', messageId)
      .execute();
  }

  /** A single message hydrated for `viewerId` (drives that viewer's own-message status ticks). */
  async findById(id: string, viewerId: string): Promise<Message | undefined> {
    const row = await db
      .selectFrom('messages')
      .select(MESSAGE_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) return undefined;
    const [reactions, receipts] = await Promise.all([
      this.reactionsFor([row.id]),
      this.receiptsFor([row.id]),
    ]);
    return toMessage(row, reactions.get(row.id) ?? [], receipts.get(row.id) ?? [], viewerId);
  }

  /** Page a conversation's messages newest-first via the opaque keyset cursor, hydrated for `viewerId`. */
  async listByConversation(
    conversationId: string,
    cursor: string | undefined,
    limit: number,
    viewerId: string,
  ): Promise<{ items: Message[]; nextCursor: string | null }> {
    let q = db
      .selectFrom('messages')
      .select(MESSAGE_COLUMNS)
      .where('conversation_id', '=', conversationId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1);

    if (cursor !== undefined) {
      const decoded = decodeCursor(cursor);
      if (decoded !== null) {
        q = q.where((eb) =>
          eb.or([
            eb('created_at', '<', decoded.createdAt),
            eb.and([eb('created_at', '=', decoded.createdAt), eb('id', '<', decoded.id)]),
          ]),
        );
      }
    }

    const rows = await q.execute();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const ids = page.map((r) => r.id);
    const [reactions, receipts] = await Promise.all([
      this.reactionsFor(ids),
      this.receiptsFor(ids),
    ]);
    const items = page.map((r) =>
      toMessage(r, reactions.get(r.id) ?? [], receipts.get(r.id) ?? [], viewerId),
    );
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last) : null;
    return { items, nextCursor };
  }

  /** Reactions for a set of message ids, grouped by message id. */
  private async reactionsFor(messageIds: ReadonlyArray<string>): Promise<Map<string, MessageReaction[]>> {
    const map = new Map<string, MessageReaction[]>();
    if (messageIds.length === 0) return map;
    const rows = await db
      .selectFrom('message_reactions')
      .select(REACTION_COLUMNS)
      .where('message_id', 'in', messageIds)
      .execute();
    for (const row of rows) {
      const list = map.get(row.message_id) ?? [];
      list.push(toReaction(row));
      map.set(row.message_id, list);
    }
    return map;
  }

  /** Every read receipt for a single message (oldest read first), for the read-receipt detail view. */
  async listReceipts(messageId: string): Promise<ReadReceipt[]> {
    const map = await this.receiptsFor([messageId]);
    return map.get(messageId) ?? [];
  }

  /** Read receipts for a set of message ids, grouped by message id (oldest read first). */
  private async receiptsFor(messageIds: ReadonlyArray<string>): Promise<Map<string, ReadReceipt[]>> {
    const map = new Map<string, ReadReceipt[]>();
    if (messageIds.length === 0) return map;
    const rows = await db
      .selectFrom('message_read_receipts')
      .select(RECEIPT_COLUMNS)
      .where('message_id', 'in', messageIds)
      .orderBy('read_at', 'asc')
      .execute();
    for (const row of rows) {
      const list = map.get(row.message_id) ?? [];
      list.push(toReceipt(row));
      map.set(row.message_id, list);
    }
    return map;
  }

  /**
   * Record that `userId` has read every message in `conversationId` created at/before `upToCreatedAt`
   * and authored by someone else. Idempotent on the unique (message, user) — only rows that did NOT
   * already exist are returned, so the caller emits a read receipt exactly once per newly-seen message.
   */
  async insertReceiptsUpTo(
    userId: string,
    conversationId: string,
    upToMessageId: string,
  ): Promise<ReadReceipt[]> {
    // Derive the boundary from the message's own `created_at` IN SQL — never round-trip it through a JS
    // Date. `timestamptz` carries microseconds; a JS Date truncates to milliseconds, so comparing
    // `created_at <= <truncated boundary>` would drop the boundary message itself (the newest one, the
    // one the reader just opened). The subquery keeps full precision so `<=` includes that message.
    const targets = await db
      .selectFrom('messages')
      .select('id')
      .where('conversation_id', '=', conversationId)
      .where('created_at', '<=', (eb) =>
        eb
          .selectFrom('messages as boundary')
          .select('boundary.created_at')
          .where('boundary.id', '=', upToMessageId)
          .where('boundary.conversation_id', '=', conversationId),
      )
      .where('sender_id', 'is not', null)
      .where('sender_id', '!=', userId)
      .execute();
    if (targets.length === 0) return [];
    const values = targets.map((t) => {
      return { message_id: t.id, user_id: userId };
    });
    const inserted = await db
      .insertInto('message_read_receipts')
      .values(values)
      .onConflict((oc) => oc.columns(['message_id', 'user_id']).doNothing())
      .returning(RECEIPT_COLUMNS)
      .execute();
    return inserted.map(toReceipt);
  }

  /**
   * Stamp delivered_at (once) on every still-undelivered message authored by someone else in a
   * conversation `userId` actively participates in — the "delivered on connect" catch-up for messages
   * that arrived while they were offline. Returns one delivered event per newly-stamped message so the
   * caller can notify each sender.
   */
  async markPendingDeliveredForUser(userId: string): Promise<PendingDelivery[]> {
    const now = new Date();
    const participantConversations = db
      .selectFrom('conversation_participants')
      .select('conversation_id')
      .where('user_id', '=', userId)
      .where('left_at', 'is', null);
    const updated = await db
      .updateTable('messages')
      .set({ delivered_at: now })
      .where('delivered_at', 'is', null)
      .where('sender_id', 'is not', null)
      .where('sender_id', '!=', userId)
      .where('conversation_id', 'in', participantConversations)
      .returning(['id', 'conversation_id', 'sender_id'])
      .execute();
    const iso = now.toISOString();
    const out: PendingDelivery[] = [];
    for (const r of updated) {
      if (r.sender_id === null) continue;
      out.push({
        messageId: r.id,
        conversationId: r.conversation_id,
        senderId: r.sender_id,
        deliveredAt: iso,
      });
    }
    return out;
  }

  /** Add a reaction (idempotent on the unique (message,user,type)). Returns the reaction. */
  async addReaction(
    messageId: string,
    userId: string,
    reactionType: ReactionType,
  ): Promise<void> {
    await db
      .insertInto('message_reactions')
      .values({ message_id: messageId, user_id: userId, reaction_type: reactionType })
      .onConflict((oc) => oc.columns(['message_id', 'user_id', 'reaction_type']).doNothing())
      .execute();
  }

  async removeReaction(
    messageId: string,
    userId: string,
    reactionType: ReactionType,
  ): Promise<void> {
    await db
      .deleteFrom('message_reactions')
      .where('message_id', '=', messageId)
      .where('user_id', '=', userId)
      .where('reaction_type', '=', reactionType)
      .execute();
  }

  /** Soft-delete a message the caller owns. Returns true when a row was affected. */
  async softDelete(messageId: string, senderId: string): Promise<boolean> {
    const result = await db
      .updateTable('messages')
      .set({ is_deleted: true, content: null })
      .where('id', '=', messageId)
      .where('sender_id', '=', senderId)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  /**
   * Stamp delivered_at once (the first time the message reaches an online recipient). Idempotent: only
   * the first call sets it; later calls return the already-stored timestamp so the tick never flickers.
   */
  async markDelivered(messageId: string): Promise<Date | null> {
    const now = new Date();
    const updated = await db
      .updateTable('messages')
      .set({ delivered_at: now })
      .where('id', '=', messageId)
      .where('delivered_at', 'is', null)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) > 0) return now;
    const row = await db
      .selectFrom('messages')
      .select('delivered_at')
      .where('id', '=', messageId)
      .executeTakeFirst();
    return row?.delivered_at ?? null;
  }

  /** The most recent message in a conversation, as a compact preview (or null when empty). */
  async lastPreview(conversationId: string): Promise<MessagePreview | null> {
    const row = await db
      .selectFrom('messages')
      .select(MESSAGE_COLUMNS)
      .where('conversation_id', '=', conversationId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!row) return null;
    return {
      id: row.id,
      senderId: row.sender_id,
      type: row.message_type,
      preview: previewText(row),
      createdAt: row.created_at.toISOString(),
    };
  }

  /** Count messages in a conversation created after the user's read watermark (not authored by them). */
  async unreadCount(
    conversationId: string,
    userId: string,
    lastReadAt: Date | null,
  ): Promise<number> {
    let q = db
      .selectFrom('messages')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('conversation_id', '=', conversationId)
      .where((eb) => eb.or([eb('sender_id', '!=', userId), eb('sender_id', 'is', null)]));
    if (lastReadAt !== null) {
      q = q.where('created_at', '>', lastReadAt);
    }
    const row = await q.executeTakeFirst();
    return row ? Number(row.count) : 0;
  }

  /** Look up when a message was created (used to translate a mark-read watermark to a timestamp). */
  async createdAtOf(messageId: string, conversationId: string): Promise<Date | undefined> {
    const row = await db
      .selectFrom('messages')
      .select('created_at')
      .where('id', '=', messageId)
      .where('conversation_id', '=', conversationId)
      .executeTakeFirst();
    return row?.created_at;
  }

  /** Reference to the typed default sender kind, kept for callers building a user message. */
  static readonly SENDER_USER = SENDER_USER;
}

export const messageRepository = new MessageRepository();
