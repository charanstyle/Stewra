import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { Database } from '../types.js';

/**
 * Let a commerce message or broadcast be deleted without letting the spend ledger be rewritten.
 *
 * The same collision `047_audit_log_unlink` fixed for `audit_log`, in a second place. 052 made
 * `commerce_spend_ledger` append-only with a trigger that raises on ANY update or delete, and gave
 * it `message_id` / `broadcast_id` as `ON DELETE SET NULL`. SET NULL is an UPDATE on the referencing
 * row, so the trigger fires on it and the parent DELETE raises
 * `commerce_spend_ledger is append-only: rows are never updated or deleted` — from inside the
 * DELETE, nowhere near the call that asked for it.
 *
 * Every rated message has a `settle` row, so in practice this made *any* delete of a commerce
 * message impossible: org teardown, the `commerceTemplates` suite's own cleanup, and any future
 * retention job. It surfaced as a failing test teardown, which reads like a test problem and is not
 * one — the schema promised two things that could not both hold.
 *
 * Both survive if the trigger stops treating "which message this entry pointed at" as part of the
 * money record. The amount, the kind, the org, the period and the timestamp are the evidence; the
 * FK is a convenience link. So exactly two updates are now permitted — clearing `message_id`, and
 * clearing `broadcast_id`, on a row that had one — with every other column compared and unchanged.
 * Every other update, and every delete, still raises as before.
 *
 * Note what this does NOT weaken: an entry can never change its amount, its kind, or its period, so
 * the period counters in `commerce_spend_periods` can still be re-derived from the ledger and the
 * totals on a closed invoice cannot be moved. The only reachable edit drops a pointer to a row that
 * no longer exists.
 *
 * `note` is compared with IS NOT DISTINCT FROM (it is nullable, and NULL = NULL is NULL rather than
 * true, which would reject the unlink on every entry that carries no note — which is most of them).
 * The two FK columns are compared the same way for the same reason: one is typically already NULL
 * while the other is being cleared.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION stewra_commerce_spend_ledger_append_only()
    RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'commerce_spend_ledger is append-only: DELETE is not permitted';
      END IF;

      -- The only permitted write: drop a link to a parent that is going away, change nothing else.
      -- Every other column is compared, so a statement that nulls message_id AND quietly edits an
      -- amount is refused like any other edit.
      IF (
           (OLD.message_id IS NOT NULL AND NEW.message_id IS NULL)
           OR (OLD.broadcast_id IS NOT NULL AND NEW.broadcast_id IS NULL)
         )
         -- ...and a column that is NOT being cleared must be identical. The test reads "NULL, or
         -- equal to what it was", so clearing one FK while the other keeps its value is allowed,
         -- and repointing either one at a different row is not.
         AND (NEW.message_id IS NULL OR NEW.message_id = OLD.message_id)
         AND (NEW.broadcast_id IS NULL OR NEW.broadcast_id = OLD.broadcast_id)
         AND NEW.id = OLD.id
         AND NEW.org_id = OLD.org_id
         AND NEW.currency = OLD.currency
         AND NEW.period_start = OLD.period_start
         AND NEW.kind = OLD.kind
         AND NEW.amount_micros = OLD.amount_micros
         AND NEW.note IS NOT DISTINCT FROM OLD.note
         AND NEW.created_at = OLD.created_at
      THEN
        RETURN NEW;
      END IF;

      RAISE EXCEPTION
        'commerce_spend_ledger is append-only: % is not permitted (only clearing message_id/broadcast_id is)',
        TG_OP;
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  // Back to 052's blanket refusal — which also restores the bug above, so `down` is a rollback of
  // this change and not a state anything should run in.
  await sql`
    CREATE OR REPLACE FUNCTION stewra_commerce_spend_ledger_append_only()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'commerce_spend_ledger is append-only: rows are never updated or deleted';
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);
}
