import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * Consent, suppression, and per-organization messaging policy — the gate every business-initiated
 * send passes through.
 *
 * This lands BEFORE broadcast rather than alongside it, deliberately. A campaign feature built first
 * and gated afterwards has a window in which it can send, and the cost of getting this wrong is not
 * ours to pay: an organization that messages people who never opted in gets ITS number banned by
 * Meta, and the people on the other end were never our customers to inconvenience.
 *
 * Three tables, three different jobs:
 *
 *   `commerce_contact_consents`   — the append-only record of what each contact agreed to, and how
 *                                   we know. Trigger-enforced immutable, like `audit_log`.
 *   `commerce_suppressions`       — the hard block list, keyed by ADDRESS rather than contact row.
 *   `commerce_messaging_policies` — per-org quiet hours and the attestation of lawful opt-in.
 *
 * Modelled on `bridge_consents` (migration 029), which stores the user's typed sentence verbatim
 * rather than a boolean. Same reasoning applied to a different party: a boolean records that someone
 * clicked something; the evidence columns here record WHAT they agreed to and WHERE, which is the
 * only form of the fact that survives a complaint six months later.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  // Append-only consent history. Opting out is a new row, never an UPDATE of the opt-in — the fact
  // that someone was once opted in is itself evidence, and a regime that overwrites it cannot answer
  // "what did you have when you sent that message?" for a message sent last March.
  await db.schema
    .createTable('commerce_contact_consents')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('org_id', 'uuid', (col) =>
      col.notNull().references('organizations.id').onDelete('cascade'),
    )
    .addColumn('contact_id', 'uuid', (col) =>
      col.notNull().references('commerce_contacts.id').onDelete('cascade'),
    )
    .addColumn('platform', 'varchar(32)', (col) => col.notNull())
    // Consent is per PURPOSE, not global. Someone who asked a question on WhatsApp has consented to
    // being answered; they have not consented to a promotion. Collapsing the two is the single most
    // common way a compliant integration becomes a non-compliant one.
    .addColumn('purpose', 'varchar(32)', (col) =>
      col.notNull().check(sql`purpose in ('service', 'marketing')`),
    )
    .addColumn('state', 'varchar(16)', (col) =>
      col.notNull().check(sql`state in ('opted_in', 'opted_out')`),
    )
    // How we know. `inbound_message` and `keyword` are self-evidencing — the customer's own message
    // is the proof. `import` and `attested` rest on the organization's word, which is why the
    // attestation in `commerce_messaging_policies` exists and why those sources are distinguishable
    // here: when a complaint arrives, "they told us so" and "they wrote to us" are not the same
    // defence and must never be stored as the same row.
    .addColumn('source', 'varchar(32)', (col) =>
      col
        .notNull()
        .check(
          sql`source in ('inbound_message', 'keyword', 'ad_click', 'web_form', 'import', 'attested')`,
        ),
    )
    // The proof itself, verbatim: the `wamid` of the message they sent, the URL of the form they
    // submitted, the ad id they clicked, the filename of the list. Free text because the shape
    // differs per source and a normalized column would force the least informative common denominator.
    .addColumn('evidence', 'text', (col) => col.notNull())
    // Which member recorded it, for the sources that rest on the organization's word. NULL when the
    // customer's own action created the row — nobody recorded that, it happened.
    .addColumn('recorded_by_user_id', 'uuid', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('recorded_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  // The current-state lookup: newest row per (contact, purpose). Every send does this read, so it is
  // the one index that must exist.
  await db.schema
    .createIndex('idx_commerce_consents_contact_purpose_recorded')
    .on('commerce_contact_consents')
    .columns(['contact_id', 'purpose', 'recorded_at'])
    .execute();

  await sql`
    CREATE OR REPLACE FUNCTION stewra_commerce_consents_append_only()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'commerce_contact_consents is append-only: % is not permitted', TG_OP;
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);
  // Enforced in the database rather than in the repository, for the same reason `audit_log` is: a
  // rule that lives only in application code is one careless `.updateTable()` away from gone, and
  // the row it would quietly rewrite is the evidence.
  await sql`
    CREATE TRIGGER trg_commerce_consents_append_only
    BEFORE UPDATE OR DELETE ON commerce_contact_consents
    FOR EACH ROW EXECUTE FUNCTION stewra_commerce_consents_append_only();
  `.execute(db);

  // The hard block list, and the reason it is keyed on the ADDRESS rather than on `contact_id`:
  // a contact row can be deleted and the same person re-imported from a fresh list tomorrow, which
  // would hand them a brand-new id and silently resurrect someone who told us to stop. The phone
  // number is the thing the person actually owns, so it is the thing the block has to follow.
  await db.schema
    .createTable('commerce_suppressions')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('org_id', 'uuid', (col) =>
      col.notNull().references('organizations.id').onDelete('cascade'),
    )
    .addColumn('platform', 'varchar(32)', (col) => col.notNull())
    /** The platform-side address — Meta's `wa_id`. Matches `commerce_contacts.external_id`. */
    .addColumn('external_id', 'varchar(64)', (col) => col.notNull())
    .addColumn('reason', 'varchar(32)', (col) =>
      col
        .notNull()
        .check(sql`reason in ('opt_out', 'complaint', 'undeliverable', 'blocked_by_platform', 'manual')`),
    )
    .addColumn('detail', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    // Scoped per org: one client's block list is not another's, and a person may genuinely want to
    // hear from one business and not the other.
    .addUniqueConstraint('uq_commerce_suppressions_org_platform_external', [
      'org_id',
      'platform',
      'external_id',
    ])
    .execute();

  // Per-organization messaging policy. The ABSENCE of a row is meaningful and is the default state:
  // an org that has not attested to lawful opt-in and has not declared quiet hours cannot broadcast
  // at all. There is no permissive fallback here on purpose — "we could not find a policy, so we
  // sent it" is the exact failure this table exists to make impossible.
  await db.schema
    .createTable('commerce_messaging_policies')
    .addColumn('org_id', 'uuid', (col) =>
      col.primaryKey().references('organizations.id').onDelete('cascade'),
    )
    // The IANA zone quiet hours are evaluated in. Required, with no default: a marketing message
    // that lands at 3am is a complaint, and guessing a zone would produce exactly that while looking
    // like it had been configured. Note the honest limitation — this is the ORGANIZATION's declared
    // zone, not each recipient's local time, which we cannot know without per-contact timezone data.
    // Recipient-local quiet hours are a later refinement; declaring one zone is the truthful version
    // of what we can currently enforce.
    .addColumn('timezone', 'varchar(64)', (col) => col.notNull())
    // Local wall-clock bounds of the window in which marketing sends are NOT permitted, e.g.
    // 21:00 → 09:00. Stored as `time` so they mean the same thing across a DST boundary.
    .addColumn('quiet_hours_start', 'time', (col) => col.notNull())
    .addColumn('quiet_hours_end', 'time', (col) => col.notNull())
    // The attestation: who signed, when, and the exact sentence they were shown. Verbatim and never
    // rewritten, for the same reason `bridge_consents.sentence` is — if we reword the statement next
    // quarter, this row still proves what THIS organization actually accepted.
    .addColumn('attested_at', 'timestamptz')
    .addColumn('attested_by_user_id', 'uuid', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('attestation_text', 'text')
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    // An attestation is a signature: it is either complete or it is not there. Three nullable columns
    // with no constraint would eventually hold a timestamp with no text, which reads as attested and
    // proves nothing.
    .addCheckConstraint(
      'ck_commerce_policy_attestation_complete',
      sql`(attested_at IS NULL AND attested_by_user_id IS NULL AND attestation_text IS NULL)
          OR (attested_at IS NOT NULL AND attestation_text IS NOT NULL)`,
    )
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('commerce_messaging_policies').execute();
  await db.schema.dropTable('commerce_suppressions').execute();
  await sql`DROP TRIGGER IF EXISTS trg_commerce_consents_append_only ON commerce_contact_consents;`.execute(
    db,
  );
  await sql`DROP FUNCTION IF EXISTS stewra_commerce_consents_append_only();`.execute(db);
  await db.schema.dropTable('commerce_contact_consents').execute();
}
