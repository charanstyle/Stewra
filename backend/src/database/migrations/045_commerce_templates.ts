import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * WhatsApp message templates — the only shape a business-initiated message can take.
 *
 * Outside the 24-hour service window Meta delivers nothing but an approved template, so this table
 * is what stands between a segment and a campaign. Every row MIRRORS a template that actually lives
 * at Meta; none of it is authoritative here.
 *
 * That mirroring is the whole design problem. Meta approves templates, re-categorizes them when it
 * disagrees with the submission, pauses them on its own when recipients report them, and deletes
 * them. A local copy that drifts does not fail loudly — it fails one recipient at a time, mid-send,
 * after the first few thousand have already arrived. So the mirror is refreshed two ways:
 *
 *   PUSH — Meta's `message_template_status_update` webhook, applied the moment it lands.
 *   PULL — the hourly `template_sync` job, which re-reads every template for every connected account.
 *
 * Either alone is insufficient. A webhook Meta failed to deliver leaves a paused template looking
 * sendable until someone notices; a pull-only design leaves it looking sendable until the next
 * sweep. `last_synced_at` records when either last confirmed a row, so "we have not heard about this
 * template in three days" is a question the UI can answer rather than one nobody can ask.
 *
 * `variable_count` is DERIVED from the body at write time, never declared by the client. It is what
 * lets a broadcast be refused before it starts: a template reading `Hi {{1}}, your {{2}} is ready`
 * dispatched with one variable is rejected by Meta per recipient, and by then the campaign is
 * already half-sent.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('commerce_templates')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('org_id', 'uuid', (col) =>
      col.notNull().references('organizations.id').onDelete('cascade'),
    )
    // Templates belong to a WABA, not to an organization: the same business with two connected
    // numbers under different WABAs has two separate sets, and Meta will not let one send the
    // other's. Cascade, because a disconnected account's templates are unreachable by definition.
    .addColumn('channel_account_id', 'uuid', (col) =>
      col.notNull().references('channel_accounts.id').onDelete('cascade'),
    )
    .addColumn('name', 'varchar(512)', (col) => col.notNull())
    .addColumn('language', 'varchar(20)', (col) => col.notNull())
    // Our closed union — `marketing` | `utility` | `authentication` — or NULL for a category Meta
    // reports that this build cannot map. The category decides the rate, so an unmapped value is
    // recorded as absent rather than rounded to the nearest one we recognize (an invented category
    // becomes a number on an invoice); `provider_category` keeps Meta's word for it.
    .addColumn('category', 'varchar(32)')
    .addColumn('provider_category', 'varchar(64)')
    // Our closed union — `pending` | `approved` | `rejected` | `paused` | `disabled` | `unknown`.
    // Only `approved` may be sent, and an unrecognized provider status maps to `unknown`, which is
    // not approved. A mapping that guessed the nearest known status is how a template Meta has
    // quietly flagged keeps going out.
    .addColumn('status', 'varchar(32)', (col) => col.notNull().defaultTo('pending'))
    // Meta's word for it, verbatim, including values this build has never heard of. The operator
    // sees what Meta actually said while the send gate sees "not approved".
    .addColumn('provider_status', 'varchar(64)', (col) => col.notNull())
    .addColumn('provider_template_id', 'varchar(128)')
    .addColumn('header_text', 'text')
    .addColumn('body_text', 'text', (col) => col.notNull())
    .addColumn('footer_text', 'text')
    .addColumn('variable_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('rejection_reason', 'text')
    .addColumn('quality_score', 'varchar(32)')
    .addColumn('last_synced_at', 'timestamptz')
    .addColumn('created_by_user_id', 'uuid', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  // Meta's own identity for a template is (WABA, name, language) — the same name in two languages is
  // two templates, and that is how a client sends the same campaign to two markets. Unique here so a
  // sync can upsert on it rather than deciding which of two local rows a remote one refreshes.
  await db.schema
    .createIndex('uq_commerce_templates_account_name_language')
    .on('commerce_templates')
    .columns(['channel_account_id', 'name', 'language'])
    .unique()
    .execute();

  // The listing query, and the one the sync walks.
  await db.schema
    .createIndex('idx_commerce_templates_org_status')
    .on('commerce_templates')
    .columns(['org_id', 'status'])
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('commerce_templates').ifExists().execute();
}
