import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * Scheduled broadcasts, and what every message actually cost.
 *
 * Two things land together because they are the same commitment made twice. A broadcast is the first
 * feature that spends a client's money without a person watching it happen, and Stewra bills that
 * money straight through at cost — so the send path and the record of what the send cost cannot be
 * built one release apart. Meta reports pricing on the delivery webhook and nowhere else; a message
 * sent before these columns existed can never have its category recovered, which is why the first
 * billing period would be the one that could not be reconstructed.
 *
 * ── The audience is resolved at DISPATCH time, never at schedule time ──
 *
 * `commerce_broadcasts` stores a `segment_id`, not a recipient list. A campaign written on Monday for
 * Friday that captured its list on Monday would message four days of opt-outs, each of whom had
 * already told the business to stop. Recipients are materialized into
 * `commerce_broadcast_recipients` by the dispatch job, at the moment it runs, from the rule as it
 * stands then.
 *
 * ── Recipients are a ledger, not a queue ──
 *
 * Every selected contact gets a row, including the ones that will never be sent to. A skipped
 * recipient with `reason = 'suppressed'` is the evidence that the consent gate ran and refused, and
 * it is what turns "1,240 selected, 890 sent" from a discrepancy into an explanation. The unique
 * index on `(broadcast_id, contact_id)` is what makes re-running a dispatch safe: a second pass adds
 * the people the first one missed and cannot add anybody twice.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('commerce_broadcasts')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('org_id', 'uuid', (col) =>
      col.notNull().references('organizations.id').onDelete('cascade'),
    )
    .addColumn('channel_account_id', 'uuid', (col) =>
      col.notNull().references('channel_accounts.id').onDelete('cascade'),
    )
    .addColumn('name', 'varchar(200)', (col) => col.notNull())
    // RESTRICT, not CASCADE and not SET NULL. A segment cannot be deleted while a broadcast points
    // at it: deleting the rule out from under a scheduled campaign would leave one that dispatches
    // to nobody, or — with `set null` and a permissive reader — to everybody. The delete is refused
    // and names the campaign, which is a sentence someone can act on.
    .addColumn('segment_id', 'uuid', (col) =>
      col.notNull().references('commerce_segments.id').onDelete('restrict'),
    )
    .addColumn('template_id', 'uuid', (col) =>
      col.notNull().references('commerce_templates.id').onDelete('restrict'),
    )
    // Positional fills for the template's `{{n}}` placeholders. A JSON array of strings; the length
    // is checked against the template's `variable_count` before the broadcast can be scheduled.
    .addColumn('variables', 'jsonb', (col) =>
      col.notNull().defaultTo(sql`'[]'::jsonb`).check(sql`jsonb_typeof(variables) = 'array'`),
    )
    .addColumn('status', 'varchar(32)', (col) => col.notNull().defaultTo('scheduled'))
    // Required, with no default. "Send now" is a timestamp in the past, said out loud. A missing
    // schedule silently meaning now is the one mistake here that cannot be undone — by the time
    // anyone notices, the messages have arrived.
    .addColumn('scheduled_for', 'timestamptz', (col) => col.notNull())
    .addColumn('started_at', 'timestamptz')
    .addColumn('completed_at', 'timestamptz')
    // Materialized counts. A report about the past: how many were reached must not change when
    // somebody later edits the segment the campaign used.
    .addColumn('total_recipients', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('sent_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('failed_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('skipped_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('last_error', 'text')
    .addColumn('created_by_user_id', 'uuid', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex('idx_commerce_broadcasts_org_created')
    .on('commerce_broadcasts')
    .columns(['org_id', 'created_at'])
    .execute();

  await db.schema
    .createTable('commerce_broadcast_recipients')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('org_id', 'uuid', (col) =>
      col.notNull().references('organizations.id').onDelete('cascade'),
    )
    .addColumn('broadcast_id', 'uuid', (col) =>
      col.notNull().references('commerce_broadcasts.id').onDelete('cascade'),
    )
    .addColumn('contact_id', 'uuid', (col) =>
      col.notNull().references('commerce_contacts.id').onDelete('cascade'),
    )
    // Snapshotted rather than joined at read time. The contact row is editable, and "who did we
    // actually send this to" is a question about the address used on the day.
    .addColumn('external_id', 'varchar(64)', (col) => col.notNull())
    .addColumn('display_name', 'varchar(200)')
    .addColumn('status', 'varchar(32)', (col) => col.notNull().defaultTo('pending'))
    .addColumn('reason', 'text')
    .addColumn('provider_message_id', 'varchar(256)')
    // The message row this produced — which is where the cost attribution lands. SET NULL rather
    // than cascade: a deleted message must not silently erase the evidence that a person was sent to.
    .addColumn('message_id', 'uuid', (col) =>
      col.references('commerce_messages.id').onDelete('set null'),
    )
    .addColumn('sent_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  // One row per person per campaign, enforced by the database rather than by the dispatcher
  // remembering. This is the whole reason a re-run of a dispatch is safe.
  await db.schema
    .createIndex('uq_commerce_broadcast_recipients_contact')
    .on('commerce_broadcast_recipients')
    .columns(['broadcast_id', 'contact_id'])
    .unique()
    .execute();

  // The send batch's claim query: the next N pending recipients of one broadcast.
  await db.schema
    .createIndex('idx_commerce_broadcast_recipients_pending')
    .on('commerce_broadcast_recipients')
    .columns(['broadcast_id', 'status'])
    .execute();

  // ── Cost attribution ──────────────────────────────────────────────────────────────────────────
  //
  // Everything below records what META said it charged, never what we expected it to charge. The two
  // disagree in practice — Meta re-categorizes templates, and a marketing template sent to someone
  // who wrote in first is billed as a service message — and the invoice follows Meta's answer. A
  // locally-derived category would make every billing disagreement unresolvable.
  await db.schema
    .alterTable('commerce_messages')
    // Which template produced this message. Null for free-form replies, which is most of the inbox.
    .addColumn('template_id', 'uuid', (col) =>
      col.references('commerce_templates.id').onDelete('set null'),
    )
    .execute();

  await db.schema
    .alterTable('commerce_messages')
    // Our closed union, or NULL for a category Meta added since this build — the verbatim word
    // lands in `provider_pricing_category` below, never rounded into a rate it was not billed at.
    .addColumn('pricing_category', 'varchar(48)')
    .execute();

  await db.schema
    .alterTable('commerce_messages')
    // Meta's raw `pricing.category`, kept verbatim next to the mapped one so a category we do not
    // model is still legible to the person reconciling an invoice.
    .addColumn('provider_pricing_category', 'varchar(64)')
    .execute();

  await db.schema
    .alterTable('commerce_messages')
    .addColumn('pricing_model', 'varchar(32)')
    .execute();

  await db.schema
    .alterTable('commerce_messages')
    // Deliberately nullable and three-valued. NULL means the delivery webhook has not arrived yet;
    // FALSE means Meta said this one is free. Collapsing them to a boolean would report every
    // in-flight message as free and under-bill everything still unsettled at period end.
    .addColumn('billable', 'boolean')
    .execute();

  await db.schema
    .alterTable('commerce_messages')
    // Meta's conversation id. Pricing went per-message on 2025-07-01, but service messages stay
    // conversation-priced until 2026-10-01 — without this, several free replies inside one paid
    // conversation are indistinguishable from several separate charges.
    .addColumn('provider_conversation_id', 'varchar(128)')
    .execute();

  // The billing query: one org's priced messages over a period, grouped by category. Partial, because
  // inbound messages are never billed and are the majority of the table.
  await sql`
    CREATE INDEX idx_commerce_messages_cost
    ON commerce_messages (org_id, created_at)
    WHERE direction = 'outbound'
  `.execute(db);

  // Delivery receipts arrive keyed on the provider's message id and nothing else, so settling one is
  // a lookup by that column alone. Without this index every status webhook is a full scan of the
  // whole message table, at the rate Meta sends them — several per message.
  await sql`
    CREATE INDEX idx_commerce_messages_provider_id
    ON commerce_messages (provider_message_id)
    WHERE provider_message_id IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_commerce_messages_provider_id`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_commerce_messages_cost`.execute(db);
  for (const column of [
    'provider_conversation_id',
    'billable',
    'pricing_model',
    'provider_pricing_category',
    'pricing_category',
    'template_id',
  ]) {
    await db.schema.alterTable('commerce_messages').dropColumn(column).execute();
  }
  await db.schema.dropTable('commerce_broadcast_recipients').ifExists().execute();
  await db.schema.dropTable('commerce_broadcasts').ifExists().execute();
}
