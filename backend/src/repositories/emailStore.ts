import { db } from '../database/index';
import { decryptField } from '../control-plane/vault/fieldCrypto';

/**
 * Data access for the encrypted email store (migration 024). Message bodies are stored as fieldCrypto
 * envelopes; the read methods here decrypt them INSIDE the control plane — plaintext never leaves via
 * a public shape and never reaches the agent runtime. All queries are user/connection scoped.
 */

export interface EmailContactRow {
  readonly id: string;
  readonly userId: string;
  readonly connectionId: string;
  readonly displayName: string;
  readonly messageCount: number;
  readonly awaitingReply: boolean;
}

export interface EmailThreadRow {
  readonly id: string;
  readonly gmailThreadId: string;
  readonly subject: string;
  readonly awaitingReply: boolean;
  readonly hasUnread: boolean;
}

/** A decrypted message, as the control plane's summarizer needs it. */
export interface EmailMessagePlain {
  readonly id: string;
  readonly threadId: string;
  readonly gmailMessageId: string;
  readonly direction: 'inbound' | 'outbound';
  readonly sentAt: Date | null;
  readonly subject: string;
  readonly snippet: string;
  /** Decrypted plaintext body ('' when none). Control-plane only — never surfaced to the client/agent. */
  readonly body: string;
  readonly labelIds: ReadonlyArray<string>;
  /** The inbound sender's contact id (null for outbound) — lets the caller resolve the sender address. */
  readonly fromContactId: string | null;
}

class EmailContactRepository {
  async findByHash(connectionId: string, sha256: string): Promise<EmailContactRow | undefined> {
    const row = await db
      .selectFrom('email_contacts')
      .selectAll()
      .where('connection_id', '=', connectionId)
      .where('address_sha256', '=', sha256)
      .executeTakeFirst();
    return row ? toContactRow(row) : undefined;
  }

  /** Insert a new contact, vaulting the address by handle (caller supplies the vault ref). */
  async create(input: {
    userId: string;
    connectionId: string;
    addressVaultRef: string;
    addressSha256: string;
    displayName: string;
    seenAt: Date;
    direction: 'inbound' | 'outbound';
  }): Promise<EmailContactRow> {
    const row = await db
      .insertInto('email_contacts')
      .values({
        user_id: input.userId,
        connection_id: input.connectionId,
        address_vault_ref: input.addressVaultRef,
        address_sha256: input.addressSha256,
        display_name: input.displayName,
        first_seen_at: input.seenAt,
        last_seen_at: input.seenAt,
        message_count: 1,
        last_inbound_at: input.direction === 'inbound' ? input.seenAt : null,
        last_outbound_at: input.direction === 'outbound' ? input.seenAt : null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toContactRow(row);
  }

  /** Bump a contact's activity counters when another message from/to them is seen. */
  async bumpActivity(
    id: string,
    seenAt: Date,
    direction: 'inbound' | 'outbound',
  ): Promise<void> {
    await db
      .updateTable('email_contacts')
      .set((eb) => ({
        message_count: eb('message_count', '+', 1),
        last_seen_at: seenAt,
        last_inbound_at: direction === 'inbound' ? seenAt : eb.ref('last_inbound_at'),
        last_outbound_at: direction === 'outbound' ? seenAt : eb.ref('last_outbound_at'),
        updated_at: new Date(),
      }))
      .where('id', '=', id)
      .execute();
  }

  async setAwaitingReply(id: string, awaiting: boolean): Promise<void> {
    await db
      .updateTable('email_contacts')
      .set({ awaiting_reply: awaiting, updated_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  /** The vault handle for a contact's email address — the caller resolves it to plaintext via the
   * vault to classify the sender (e.g. no-reply detection). Control-plane only. */
  async addressVaultRefById(id: string): Promise<string | undefined> {
    const row = await db
      .selectFrom('email_contacts')
      .select('address_vault_ref')
      .where('id', '=', id)
      .executeTakeFirst();
    return row?.address_vault_ref;
  }

  /** Contacts the user currently owes a reply — the "who's waiting on you" source for the briefing. */
  async listAwaitingReply(userId: string, limit: number): Promise<ReadonlyArray<EmailContactRow>> {
    const rows = await db
      .selectFrom('email_contacts')
      .selectAll()
      .where('user_id', '=', userId)
      .where('awaiting_reply', '=', true)
      .orderBy('last_inbound_at', 'desc')
      .limit(limit)
      .execute();
    return rows.map(toContactRow);
  }
}

class EmailThreadRepository {
  async findByGmailId(
    connectionId: string,
    gmailThreadId: string,
  ): Promise<EmailThreadRow | undefined> {
    const row = await db
      .selectFrom('email_threads')
      .selectAll()
      .where('connection_id', '=', connectionId)
      .where('gmail_thread_id', '=', gmailThreadId)
      .executeTakeFirst();
    return row ? toThreadRow(row) : undefined;
  }

  /** Insert-or-update a thread by (connection, gmail_thread_id), returning its id. */
  async upsert(input: {
    userId: string;
    connectionId: string;
    gmailThreadId: string;
    subject: string;
    lastMessageAt: Date | null;
    participantContactIds: ReadonlyArray<string>;
    hasUnread: boolean;
    awaitingReply: boolean;
  }): Promise<EmailThreadRow> {
    const row = await db
      .insertInto('email_threads')
      .values({
        user_id: input.userId,
        connection_id: input.connectionId,
        gmail_thread_id: input.gmailThreadId,
        subject: input.subject,
        last_message_at: input.lastMessageAt,
        participant_contact_ids: JSON.stringify(input.participantContactIds),
        has_unread: input.hasUnread,
        awaiting_reply: input.awaitingReply,
      })
      .onConflict((oc) =>
        oc.columns(['connection_id', 'gmail_thread_id']).doUpdateSet({
          subject: input.subject,
          last_message_at: input.lastMessageAt,
          participant_contact_ids: JSON.stringify(input.participantContactIds),
          has_unread: input.hasUnread,
          awaiting_reply: input.awaitingReply,
          updated_at: new Date(),
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return toThreadRow(row);
  }

  async findByIdForUser(id: string, userId: string): Promise<EmailThreadRow | undefined> {
    const row = await db
      .selectFrom('email_threads')
      .selectAll()
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row ? toThreadRow(row) : undefined;
  }

  /** Flip a thread's awaiting-reply flag — used to self-heal a stale/misclassified flag at read time. */
  async setAwaitingReply(id: string, awaiting: boolean): Promise<void> {
    await db
      .updateTable('email_threads')
      .set({ awaiting_reply: awaiting, updated_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  /** Threads the user owes a reply on, newest first — the briefing/nudge source. */
  async listAwaitingReply(userId: string, limit: number): Promise<ReadonlyArray<EmailThreadRow>> {
    const rows = await db
      .selectFrom('email_threads')
      .selectAll()
      .where('user_id', '=', userId)
      .where('awaiting_reply', '=', true)
      .orderBy('last_message_at', 'desc')
      .limit(limit)
      .execute();
    return rows.map(toThreadRow);
  }
}

class EmailMessageRepository {
  async existsByGmailId(connectionId: string, gmailMessageId: string): Promise<boolean> {
    const row = await db
      .selectFrom('email_messages')
      .select('id')
      .where('connection_id', '=', connectionId)
      .where('gmail_message_id', '=', gmailMessageId)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** Insert a message with its body already encrypted by the caller (fieldCrypto envelope). */
  async insert(input: {
    userId: string;
    connectionId: string;
    threadId: string;
    gmailMessageId: string;
    gmailHistoryId: string | null;
    fromContactId: string | null;
    direction: 'inbound' | 'outbound';
    sentAt: Date | null;
    subject: string;
    snippet: string;
    bodyCiphertext: string;
    labelIds: ReadonlyArray<string>;
  }): Promise<void> {
    await db
      .insertInto('email_messages')
      .values({
        user_id: input.userId,
        connection_id: input.connectionId,
        thread_id: input.threadId,
        gmail_message_id: input.gmailMessageId,
        gmail_history_id: input.gmailHistoryId,
        from_contact_id: input.fromContactId,
        direction: input.direction,
        sent_at: input.sentAt,
        subject: input.subject,
        snippet: input.snippet,
        body_ciphertext: input.bodyCiphertext,
        label_ids: JSON.stringify(input.labelIds),
      })
      .onConflict((oc) => oc.columns(['connection_id', 'gmail_message_id']).doNothing())
      .execute();
  }

  /** The latest message in a thread — used to (re)derive its awaiting-reply state. */
  async latestInThread(threadId: string): Promise<EmailMessagePlain | undefined> {
    const row = await db
      .selectFrom('email_messages')
      .selectAll()
      .where('thread_id', '=', threadId)
      .orderBy('sent_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row ? toMessagePlain(row) : undefined;
  }

  /** All messages in one thread (decrypted), chronological — the context for drafting a reply. */
  async forThread(
    userId: string,
    threadId: string,
    limit: number,
  ): Promise<ReadonlyArray<EmailMessagePlain>> {
    const rows = await db
      .selectFrom('email_messages')
      .selectAll()
      .where('user_id', '=', userId)
      .where('thread_id', '=', threadId)
      .orderBy('sent_at', 'asc')
      .limit(limit)
      .execute();
    return rows.map(toMessagePlain);
  }

  /** Recent messages across the user's mailbox (decrypted), newest first — briefing context. */
  async recent(userId: string, limit: number): Promise<ReadonlyArray<EmailMessagePlain>> {
    const rows = await db
      .selectFrom('email_messages')
      .selectAll()
      .where('user_id', '=', userId)
      .orderBy('sent_at', 'desc')
      .limit(limit)
      .execute();
    return rows.map(toMessagePlain);
  }

  /** Full conversation history with one contact (decrypted), chronological — deep per-contact context. */
  async historyForContact(
    userId: string,
    contactId: string,
    limit: number,
  ): Promise<ReadonlyArray<EmailMessagePlain>> {
    const rows = await db
      .selectFrom('email_messages')
      .selectAll()
      .where('user_id', '=', userId)
      .where('from_contact_id', '=', contactId)
      .orderBy('sent_at', 'asc')
      .limit(limit)
      .execute();
    return rows.map(toMessagePlain);
  }

  /** Retention sweep: delete messages older than the cutoff for a user. Returns rows removed. */
  async deleteOlderThan(userId: string, cutoff: Date): Promise<number> {
    const result = await db
      .deleteFrom('email_messages')
      .where('user_id', '=', userId)
      .where('sent_at', '<', cutoff)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0n);
  }
}

class EmailSyncStateRepository {
  async getForConnection(connectionId: string): Promise<
    | {
        connectionId: string;
        userId: string;
        lastHistoryId: string | null;
        backfillCursor: string | null;
        backfillComplete: boolean;
        retentionDays: number;
      }
    | undefined
  > {
    const row = await db
      .selectFrom('email_sync_state')
      .selectAll()
      .where('connection_id', '=', connectionId)
      .executeTakeFirst();
    if (!row) {
      return undefined;
    }
    return {
      connectionId: row.connection_id,
      userId: row.user_id,
      lastHistoryId: row.last_history_id,
      backfillCursor: row.backfill_cursor,
      backfillComplete: row.backfill_complete,
      retentionDays: row.retention_days,
    };
  }

  /** Ensure a sync-state row exists for a connection, seeding the retention window. */
  async ensure(connectionId: string, userId: string, retentionDays: number): Promise<void> {
    await db
      .insertInto('email_sync_state')
      .values({ connection_id: connectionId, user_id: userId, retention_days: retentionDays })
      .onConflict((oc) =>
        oc.column('connection_id').doUpdateSet({ retention_days: retentionDays, updated_at: new Date() }),
      )
      .execute();
  }

  async update(
    connectionId: string,
    patch: {
      lastHistoryId?: string | null;
      backfillCursor?: string | null;
      backfillComplete?: boolean;
      lastSyncedAt?: Date | null;
    },
  ): Promise<void> {
    await db
      .updateTable('email_sync_state')
      .set({
        ...(patch.lastHistoryId !== undefined ? { last_history_id: patch.lastHistoryId } : {}),
        ...(patch.backfillCursor !== undefined ? { backfill_cursor: patch.backfillCursor } : {}),
        ...(patch.backfillComplete !== undefined ? { backfill_complete: patch.backfillComplete } : {}),
        ...(patch.lastSyncedAt !== undefined ? { last_synced_at: patch.lastSyncedAt } : {}),
        updated_at: new Date(),
      })
      .where('connection_id', '=', connectionId)
      .execute();
  }
}

function toContactRow(row: {
  id: string;
  user_id: string;
  connection_id: string;
  display_name: string;
  message_count: number;
  awaiting_reply: boolean;
}): EmailContactRow {
  return {
    id: row.id,
    userId: row.user_id,
    connectionId: row.connection_id,
    displayName: row.display_name,
    messageCount: row.message_count,
    awaitingReply: row.awaiting_reply,
  };
}

function toThreadRow(row: {
  id: string;
  gmail_thread_id: string;
  subject: string;
  awaiting_reply: boolean;
  has_unread: boolean;
}): EmailThreadRow {
  return {
    id: row.id,
    gmailThreadId: row.gmail_thread_id,
    subject: row.subject,
    awaitingReply: row.awaiting_reply,
    hasUnread: row.has_unread,
  };
}

function toMessagePlain(row: {
  id: string;
  thread_id: string;
  gmail_message_id: string;
  direction: 'inbound' | 'outbound';
  sent_at: Date | null;
  subject: string;
  snippet: string;
  body_ciphertext: string;
  label_ids: ReadonlyArray<string>;
  from_contact_id: string | null;
}): EmailMessagePlain {
  return {
    id: row.id,
    threadId: row.thread_id,
    gmailMessageId: row.gmail_message_id,
    direction: row.direction,
    sentAt: row.sent_at,
    subject: row.subject,
    snippet: row.snippet,
    body: row.body_ciphertext.length > 0 ? decryptField(row.body_ciphertext) : '',
    labelIds: row.label_ids,
    fromContactId: row.from_contact_id,
  };
}

/**
 * Purge ALL stored email data for one connection (used on disconnect — the connection row is only
 * flipped to `revoked`, so the ON DELETE CASCADE never fires). Returns the contact address vault
 * refs so the caller can delete those secrets too — no dead credential or vaulted address lingers.
 */
export async function purgeConnectionEmailData(
  connectionId: string,
): Promise<ReadonlyArray<string>> {
  const contactRefs = await db
    .selectFrom('email_contacts')
    .select('address_vault_ref')
    .where('connection_id', '=', connectionId)
    .execute();
  await db.deleteFrom('email_messages').where('connection_id', '=', connectionId).execute();
  await db.deleteFrom('email_threads').where('connection_id', '=', connectionId).execute();
  await db.deleteFrom('email_contacts').where('connection_id', '=', connectionId).execute();
  await db.deleteFrom('email_sync_state').where('connection_id', '=', connectionId).execute();
  return contactRefs.map((r) => r.address_vault_ref);
}

export const emailContactRepository = new EmailContactRepository();
export const emailThreadRepository = new EmailThreadRepository();
export const emailMessageRepository = new EmailMessageRepository();
export const emailSyncStateRepository = new EmailSyncStateRepository();
