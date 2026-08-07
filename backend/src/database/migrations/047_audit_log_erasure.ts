import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * Let a person be erased from the audit log without letting the log be edited.
 *
 * `002_audit_log` made the table append-only with a trigger that raises on ANY update or delete.
 * `audit_log.user_id` is `ON DELETE SET NULL`, and SET NULL is an UPDATE on the referencing row — so
 * the trigger fired on it, and deleting a user who had ever generated a single audit row failed with
 * `audit_log is append-only: UPDATE is not permitted`. Since a login writes one, that is every real
 * user. Account deletion was impossible, and nothing said so until the DELETE was attempted.
 *
 * That is a straight collision between two things the product promises: the log is tamper-evident
 * (build-plan.md §5) and deletion is real, not hidden (memory-and-learning.md §5). Both survive if the
 * trigger stops treating "who this row was about" as part of the record's content. So exactly one
 * update is now permitted — clearing `user_id` on a row that had one — and every other update, plus
 * every delete, still raises as before. An attacker who wants to rewrite history gains nothing: the
 * only reachable edit is the one that removes a name and keeps the event.
 *
 * Deliberately NOT done here — the two limits worth knowing:
 *
 *  - `summary` can still name a person ("Sent email to alice@example.com"). Nulling `user_id`
 *    unlinks the row from its subject; it does not redact third parties out of the prose. Real
 *    erasure needs a redaction pass over `summary`/`metadata`, which is a product decision about what
 *    the feed should read like afterwards, not a schema fix.
 *  - The `REVOKE UPDATE, DELETE ON audit_log FROM <app_role>` that 002's comment asks for is not
 *    issued here, because it cannot work as written: migrations run as the role that owns the table,
 *    and Postgres does not honour REVOKE against an owner. It needs a SECOND, non-owning role for the
 *    application to connect as — an ops change, documented rather than faked. Until then this trigger
 *    is the enforcement, which is why it is written to be safe on its own.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION stewra_audit_log_append_only()
    RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'audit_log is append-only: DELETE is not permitted';
      END IF;

      -- The one permitted write: unlink the subject, change nothing else. Every column is compared,
      -- so a statement that nulls user_id AND quietly edits a summary is refused like any other edit.
      -- IS NOT DISTINCT FROM on the nullable column, because NULL = NULL is NULL rather than true,
      -- and plain equality would reject the erasure of a row whose resource_id is absent.
      IF OLD.user_id IS NOT NULL
         AND NEW.user_id IS NULL
         AND NEW.id = OLD.id
         AND NEW.action = OLD.action
         AND NEW.resource_type = OLD.resource_type
         AND NEW.resource_id IS NOT DISTINCT FROM OLD.resource_id
         AND NEW.summary = OLD.summary
         AND NEW.success = OLD.success
         AND NEW.metadata = OLD.metadata
         AND NEW.created_at = OLD.created_at
      THEN
        RETURN NEW;
      END IF;

      RAISE EXCEPTION 'audit_log is append-only: % is not permitted (only clearing user_id is)', TG_OP;
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  // Back to 002's version: refuse everything. Restores the deletion deadlock, which is the point of
  // a down migration — it returns the schema to what it was, not to what it should have been.
  await sql`
    CREATE OR REPLACE FUNCTION stewra_audit_log_append_only()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP;
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);
}
