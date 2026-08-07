import type { Selectable } from 'kysely';
import { sql } from 'kysely';
import type {
  BroadcastRecipient,
  BroadcastRecipientStatus,
  BroadcastStatus,
  CommerceBroadcast,
} from '@stewra/shared-types';
import { db } from '../../database/index.js';
import type {
  CommerceBroadcastRecipientsTable,
  CommerceBroadcastsTable,
} from '../../database/types.js';

type BroadcastRow = Selectable<CommerceBroadcastsTable>;
type RecipientRow = Selectable<CommerceBroadcastRecipientsTable>;

/**
 * `variables` is jsonb, which at the type level could hold anything. A predicate rather than a cast,
 * same as the job payload: the check and the narrowing are one statement. The migration constrains
 * the column to a jsonb array, but not to an array OF STRINGS — this is the only place that checks.
 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function toBroadcast(row: BroadcastRow): CommerceBroadcast {
  if (!isStringArray(row.variables)) {
    throw new Error(`broadcast ${row.id} has variables that are not an array of strings`);
  }
  return {
    id: row.id,
    orgId: row.org_id,
    channelAccountId: row.channel_account_id,
    name: row.name,
    segmentId: row.segment_id,
    templateId: row.template_id,
    variables: row.variables,
    status: row.status,
    scheduledFor: row.scheduled_for.toISOString(),
    startedAt: row.started_at === null ? null : row.started_at.toISOString(),
    completedAt: row.completed_at === null ? null : row.completed_at.toISOString(),
    totalRecipients: row.total_recipients,
    sentCount: row.sent_count,
    failedCount: row.failed_count,
    skippedCount: row.skipped_count,
    lastError: row.last_error,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toRecipient(row: RecipientRow): BroadcastRecipient {
  return {
    id: row.id,
    orgId: row.org_id,
    broadcastId: row.broadcast_id,
    contactId: row.contact_id,
    externalId: row.external_id,
    displayName: row.display_name,
    status: row.status,
    reason: row.reason,
    providerMessageId: row.provider_message_id,
    messageId: row.message_id,
    sentAt: row.sent_at === null ? null : row.sent_at.toISOString(),
  };
}

/**
 * Broadcasts and their recipient ledger (migration 046).
 *
 * Two invariants live here rather than in the service, because the database is the only participant
 * every worker shares:
 *
 *  - **Status changes are compare-and-set.** Every transition names the states it may move FROM, so
 *    a cancel racing a dispatch resolves to whichever landed first instead of to both. The loser
 *    gets null back and must re-read, not overwrite.
 *  - **A recipient is claimed, not read.** `claimPending` flips rows to `sending` in the same
 *    statement that returns them, with SKIP LOCKED — two send jobs walking one broadcast divide the
 *    audience instead of double-messaging it.
 */
class BroadcastRepository {
  async listForOrg(orgId: string, limit: number): Promise<CommerceBroadcast[]> {
    const rows = await db
      .selectFrom('commerce_broadcasts')
      .selectAll()
      .where('org_id', '=', orgId)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .execute();
    return rows.map(toBroadcast);
  }

  async findById(orgId: string, broadcastId: string): Promise<CommerceBroadcast | null> {
    const row = await db
      .selectFrom('commerce_broadcasts')
      .selectAll()
      .where('org_id', '=', orgId)
      .where('id', '=', broadcastId)
      .executeTakeFirst();
    return row === undefined ? null : toBroadcast(row);
  }

  async create(params: {
    orgId: string;
    channelAccountId: string;
    name: string;
    segmentId: string;
    templateId: string;
    variables: readonly string[];
    scheduledFor: Date;
    createdByUserId: string;
  }): Promise<CommerceBroadcast> {
    const row = await db
      .insertInto('commerce_broadcasts')
      .values({
        org_id: params.orgId,
        channel_account_id: params.channelAccountId,
        name: params.name,
        segment_id: params.segmentId,
        template_id: params.templateId,
        variables: JSON.stringify(params.variables),
        scheduled_for: params.scheduledFor,
        created_by_user_id: params.createdByUserId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toBroadcast(row);
  }

  /**
   * Move a broadcast between states, but only from a state it is actually in.
   *
   * Returns the updated broadcast, or null when the row was not in any of `from` — which means
   * somebody else moved it first, and the caller's plan is stale. Callers treat null as "re-read and
   * reconsider", never as "write harder".
   */
  async transition(params: {
    orgId: string;
    broadcastId: string;
    from: readonly BroadcastStatus[];
    to: BroadcastStatus;
    startedAt?: Date;
    completedAt?: Date;
    lastError?: string | null;
  }): Promise<CommerceBroadcast | null> {
    const row = await db
      .updateTable('commerce_broadcasts')
      .set({
        status: params.to,
        ...(params.startedAt === undefined ? {} : { started_at: params.startedAt }),
        ...(params.completedAt === undefined ? {} : { completed_at: params.completedAt }),
        ...(params.lastError === undefined ? {} : { last_error: params.lastError }),
        updated_at: new Date(),
      })
      .where('org_id', '=', params.orgId)
      .where('id', '=', params.broadcastId)
      .where('status', 'in', [...params.from])
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? null : toBroadcast(row);
  }

  /**
   * Materialize one page of the audience into the ledger.
   *
   * `ON CONFLICT DO NOTHING` on `(broadcast_id, contact_id)` is what makes a re-run of a dispatch
   * additive: the second pass inserts only who the first one missed, and a recipient already sent to
   * cannot be re-inserted as `pending`.
   */
  async insertRecipients(
    rows: ReadonlyArray<{
      orgId: string;
      broadcastId: string;
      contactId: string;
      externalId: string;
      displayName: string | null;
      status: Extract<BroadcastRecipientStatus, 'pending' | 'skipped'>;
      reason: string | null;
    }>,
  ): Promise<void> {
    if (rows.length === 0) return;
    await db
      .insertInto('commerce_broadcast_recipients')
      .values(
        rows.map((row) => ({
          org_id: row.orgId,
          broadcast_id: row.broadcastId,
          contact_id: row.contactId,
          external_id: row.externalId,
          display_name: row.displayName,
          status: row.status,
          reason: row.reason,
        })),
      )
      .onConflict((oc) => oc.columns(['broadcast_id', 'contact_id']).doNothing())
      .execute();
  }

  /**
   * Take up to `limit` pending recipients and mark them `sending` in the same statement.
   *
   * The flip-and-return is the idempotency mechanism the send handler's docs lean on: a worker that
   * dies after claiming leaves rows in `sending`, and `sending` is deliberately never reclaimed —
   * messaging a person twice is worse than the unknown outcome staying unknown.
   */
  async claimPending(broadcastId: string, limit: number): Promise<BroadcastRecipient[]> {
    const result = await sql<RecipientRow>`
      WITH claimable AS (
        SELECT id
        FROM commerce_broadcast_recipients
        WHERE broadcast_id = ${broadcastId}
          AND status = 'pending'
        ORDER BY created_at ASC, id ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE commerce_broadcast_recipients AS r
      SET status = 'sending'
      FROM claimable
      WHERE r.id = claimable.id
      RETURNING r.*
    `.execute(db);
    return result.rows.map(toRecipient);
  }

  /**
   * Put claimed-but-untouched recipients back on the queue.
   *
   * Only valid BEFORE any send attempt — the quiet-hours pause, where the consent gate refused the
   * whole batch before a single request went out. The WHERE on `sending` keeps a row that somehow
   * progressed from being dragged backwards.
   */
  async releaseClaims(recipientIds: readonly string[]): Promise<void> {
    if (recipientIds.length === 0) return;
    await db
      .updateTable('commerce_broadcast_recipients')
      .set({ status: 'pending' })
      .where('id', 'in', [...recipientIds])
      .where('status', '=', 'sending')
      .execute();
  }

  /** Record one recipient's outcome. `sentAt` accompanies `sent`; `reason` explains the others. */
  async settleRecipient(params: {
    recipientId: string;
    status: Extract<BroadcastRecipientStatus, 'sent' | 'failed' | 'skipped'>;
    reason: string | null;
    providerMessageId: string | null;
    messageId: string | null;
    sentAt: Date | null;
  }): Promise<void> {
    await db
      .updateTable('commerce_broadcast_recipients')
      .set({
        status: params.status,
        reason: params.reason,
        provider_message_id: params.providerMessageId,
        message_id: params.messageId,
        sent_at: params.sentAt,
      })
      .where('id', '=', params.recipientId)
      .execute();
  }

  /**
   * Note what went wrong on a recipient WITHOUT settling it.
   *
   * For the unknown-outcome case only: the send call errored in a way that does not say whether Meta
   * delivered. The row stays `sending` — the one status that is never retried — and the reason is
   * the evidence of why it is stuck there.
   */
  async noteSendingError(recipientId: string, reason: string): Promise<void> {
    await db
      .updateTable('commerce_broadcast_recipients')
      .set({ reason })
      .where('id', '=', recipientId)
      .where('status', '=', 'sending')
      .execute();
  }

  async pendingCount(broadcastId: string): Promise<number> {
    const row = await db
      .selectFrom('commerce_broadcast_recipients')
      .select(db.fn.countAll<string>().as('count'))
      .where('broadcast_id', '=', broadcastId)
      .where('status', '=', 'pending')
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  /**
   * Recompute the broadcast's materialized counts from the ledger.
   *
   * Derived on demand rather than incremented per send, because increments drift the moment any
   * write path is retried — and the ledger is right there, already holding the truth.
   */
  async refreshCounts(broadcastId: string): Promise<void> {
    await sql`
      UPDATE commerce_broadcasts b
      SET total_recipients = counts.total,
          sent_count = counts.sent,
          failed_count = counts.failed,
          skipped_count = counts.skipped,
          updated_at = now()
      FROM (
        SELECT count(*) AS total,
               count(*) FILTER (WHERE status = 'sent') AS sent,
               count(*) FILTER (WHERE status = 'failed') AS failed,
               count(*) FILTER (WHERE status = 'skipped') AS skipped
        FROM commerce_broadcast_recipients
        WHERE broadcast_id = ${broadcastId}
      ) AS counts
      WHERE b.id = ${broadcastId}
    `.execute(db);
  }

  async listRecipients(params: {
    orgId: string;
    broadcastId: string;
    status: BroadcastRecipientStatus | undefined;
    limit: number;
    offset: number;
  }): Promise<BroadcastRecipient[]> {
    let query = db
      .selectFrom('commerce_broadcast_recipients')
      .selectAll()
      .where('org_id', '=', params.orgId)
      .where('broadcast_id', '=', params.broadcastId)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .limit(params.limit)
      .offset(params.offset);
    if (params.status !== undefined) {
      query = query.where('status', '=', params.status);
    }
    const rows = await query.execute();
    return rows.map(toRecipient);
  }

  /**
   * Which broadcasts still point at a segment and can still send. Asked before a segment delete —
   * the RESTRICT foreign key would refuse anyway, but with a constraint name instead of a sentence.
   */
  async broadcastsUsingSegment(orgId: string, segmentId: string): Promise<string[]> {
    const rows = await db
      .selectFrom('commerce_broadcasts')
      .select('name')
      .where('org_id', '=', orgId)
      .where('segment_id', '=', segmentId)
      .where('status', 'in', ['scheduled', 'running', 'paused'])
      .execute();
    return rows.map((row) => row.name);
  }
}

export const broadcastRepository = new BroadcastRepository();
