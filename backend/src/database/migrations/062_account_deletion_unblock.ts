import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * Make `DELETE FROM users` possible at all.
 *
 * `047_audit_log_erasure` found the first reason a user could not be deleted and fixed it;
 * `058_spend_ledger_unlink` found the second. Neither swept for the rest, so five more remained,
 * every one of them invisible until the DELETE was actually attempted. This migration is that sweep.
 * It changes no data and grants no new ability to edit history — it only stops four constraints and
 * one cascade from meaning something nobody intended them to mean.
 *
 * The four blockers, and why each is a defect rather than a rule worth keeping:
 *
 *  1. **`organizations.created_by` was `NOT NULL … ON DELETE RESTRICT`** (`038:31`), two lines under a
 *     comment reading "kept for provenance only — it confers nothing; ownership lives in org_members
 *     and is transferable, so a departing founder does not take the organization with them." The
 *     constraint said the reverse: it made that founder permanently undeletable. Every other
 *     attribution column in the commerce plane — `created_by_user_id` on broadcasts, templates,
 *     segments, imports, opt-in links, spend caps and subscriptions, `attested_by_user_id` on
 *     messaging policies — is already nullable `ON DELETE SET NULL`. This one is now the same.
 *
 *  2, 3, 4. **Three append-only triggers colliding with their own `SET NULL` foreign keys.** This is
 *     precisely the bug 047 documented: `SET NULL` is an UPDATE on the referencing row, and a
 *     `BEFORE UPDATE` trigger that raises unconditionally fires on it. So `commerce_contact_consents`
 *     (`042:79-94`), `commerce_plan_versions` (`053:55-67`) and `commerce_rate_cards` (`050:80-104`)
 *     each declared a user reference that releases on delete, and then installed a trigger
 *     guaranteeing the release could never happen. Each now permits exactly one update — clearing its
 *     own user column, with every other column byte-identical — and refuses everything else as
 *     before. The evidence, the priced plan version and the loaded rate card all survive intact; only
 *     the name comes off, which is the same trade 047 already made for the audit log.
 *
 * And one cascade that was quietly destroying other people's data:
 *
 *  5. **`conversations.created_by` was `ON DELETE CASCADE`** (`015:18-20`), while `messages.sender_id`
 *     one migration later is `ON DELETE SET NULL` with the comment "keeps history readable after a
 *     user is neutralized" (`016:18-19`). The second intention cannot survive the first: deleting a
 *     user dropped every conversation they had ever *started* — group threads with a dozen other
 *     people, and all the messages in them — so there was no history left to keep readable. Whoever
 *     happened to tap "new group" owned everyone's record of it. Now `SET NULL`: the leaver's
 *     `conversation_participants` row still cascades, so they genuinely leave, their messages keep
 *     the null `sender_id` that was always intended for them, and the thread survives for the people
 *     still in it. A thread left with nobody in it is deleted by `accountDeletionService`, where
 *     "was anyone else here?" can actually be asked — a foreign key cannot ask it.
 *
 * What this migration deliberately does NOT do: decide what becomes of an organization whose last
 * member leaves, or of a conversation whose last participant leaves. Those are policy, they need to
 * be explained to the person doing the deleting, and they live in `accountDeletionService`. Schema's
 * only job here is to stop making the question unanswerable.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  // --- 1. organizations.created_by: RESTRICT -> SET NULL -------------------------------------
  await sql`ALTER TABLE organizations ALTER COLUMN created_by DROP NOT NULL`.execute(db);
  await sql`ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_created_by_fkey`.execute(
    db,
  );
  await sql`
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
  `.execute(db);

  // --- 5. conversations.created_by: CASCADE -> SET NULL --------------------------------------
  await sql`ALTER TABLE conversations ALTER COLUMN created_by DROP NOT NULL`.execute(db);
  await sql`ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_created_by_fkey`.execute(
    db,
  );
  await sql`
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
  `.execute(db);

  // --- 2. commerce_contact_consents ----------------------------------------------------------
  // Was: raise on any UPDATE or DELETE. Now: permit only the unlinking of the recorder. The
  // evidence, the purpose, the source and the timestamp — everything that makes the row proof that
  // someone opted in — are all compared, so a statement that clears the recorder AND edits the
  // evidence is refused exactly like any other edit.
  await sql`
    CREATE OR REPLACE FUNCTION stewra_commerce_consents_append_only()
    RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'commerce_contact_consents is append-only: DELETE is not permitted';
      END IF;

      IF OLD.recorded_by_user_id IS NOT NULL
         AND NEW.recorded_by_user_id IS NULL
         AND NEW.id = OLD.id
         AND NEW.org_id = OLD.org_id
         AND NEW.contact_id = OLD.contact_id
         AND NEW.platform = OLD.platform
         AND NEW.purpose = OLD.purpose
         AND NEW.state = OLD.state
         AND NEW.source = OLD.source
         AND NEW.evidence = OLD.evidence
         AND NEW.recorded_at = OLD.recorded_at
         AND NEW.optin_link_id IS NOT DISTINCT FROM OLD.optin_link_id
      THEN
        RETURN NEW;
      END IF;

      RAISE EXCEPTION 'commerce_contact_consents is append-only: % is not permitted (only clearing recorded_by_user_id is)', TG_OP;
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);

  // --- 3. commerce_plan_versions -------------------------------------------------------------
  // A version is what somebody's invoice was computed from, so the money columns stay frozen. Only
  // the authoring name comes off.
  await sql`
    CREATE OR REPLACE FUNCTION stewra_commerce_plan_versions_append_only()
    RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'commerce_plan_versions is append-only: DELETE is not permitted; create a new version instead';
      END IF;

      IF OLD.created_by_user_id IS NOT NULL
         AND NEW.created_by_user_id IS NULL
         AND NEW.id = OLD.id
         AND NEW.plan_id = OLD.plan_id
         AND NEW.version = OLD.version
         AND NEW.platform_fee_micros = OLD.platform_fee_micros
         AND NEW.currency = OLD.currency
         AND NEW.note = OLD.note
         AND NEW.created_at = OLD.created_at
      THEN
        RETURN NEW;
      END IF;

      RAISE EXCEPTION 'commerce_plan_versions is append-only: % is not permitted (only clearing created_by_user_id is); create a new version instead', TG_OP;
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);

  // --- 4. commerce_rate_cards ----------------------------------------------------------------
  // This one already permitted a single edit — closing an open card by setting `effective_to`. It
  // now permits a second, disjoint one: clearing the loader. Both branches keep every other column
  // pinned, so the prices a closed invoice was computed from still cannot move.
  await sql`
    CREATE OR REPLACE FUNCTION stewra_commerce_rate_cards_close_only()
    RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'commerce_rate_cards is append-only: DELETE is not permitted';
      END IF;

      -- Erasure: drop the loader's name, touch nothing else (effective_to included, so this cannot
      -- be used to smuggle a card closure through).
      IF OLD.loaded_by_user_id IS NOT NULL
         AND NEW.loaded_by_user_id IS NULL
         AND NEW.id = OLD.id
         AND NEW.currency = OLD.currency
         AND NEW.effective_from = OLD.effective_from
         AND NEW.effective_to IS NOT DISTINCT FROM OLD.effective_to
         AND NEW.source_note = OLD.source_note
         AND NEW.created_at = OLD.created_at
      THEN
        RETURN NEW;
      END IF;

      -- The original rule, unchanged: an open card may be closed and nothing else.
      IF OLD.effective_to IS NOT NULL
         OR NEW.effective_to IS NULL
         OR NEW.id IS DISTINCT FROM OLD.id
         OR NEW.currency IS DISTINCT FROM OLD.currency
         OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
         OR NEW.source_note IS DISTINCT FROM OLD.source_note
         OR NEW.loaded_by_user_id IS DISTINCT FROM OLD.loaded_by_user_id
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'commerce_rate_cards rows may only be closed (effective_to NULL -> value) or unlinked from a deleted user; load a new card instead of editing this one';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  // The three trigger functions go back to their pre-erasure text verbatim. That restores the
  // deletion deadlock, which is the point of a down migration: it returns the schema to what it was,
  // not to what it should have been.
  await sql`
    CREATE OR REPLACE FUNCTION stewra_commerce_consents_append_only()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'commerce_contact_consents is append-only: % is not permitted', TG_OP;
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION stewra_commerce_plan_versions_append_only()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'commerce_plan_versions is append-only: % is not permitted; create a new version instead', TG_OP;
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);

  await sql`
    CREATE OR REPLACE FUNCTION stewra_commerce_rate_cards_close_only()
    RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'commerce_rate_cards is append-only: DELETE is not permitted';
      END IF;
      IF OLD.effective_to IS NOT NULL
         OR NEW.effective_to IS NULL
         OR NEW.id IS DISTINCT FROM OLD.id
         OR NEW.currency IS DISTINCT FROM OLD.currency
         OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
         OR NEW.source_note IS DISTINCT FROM OLD.source_note
         OR NEW.loaded_by_user_id IS DISTINCT FROM OLD.loaded_by_user_id
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'commerce_rate_cards rows may only be closed (effective_to NULL -> value); load a new card instead of editing this one';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);

  // The two foreign keys go back to their original actions. NOT NULL is deliberately NOT restored on
  // either column: any row whose referent has since been deleted now holds a legitimate NULL, and
  // inventing a creator to satisfy the constraint would be a lie in a provenance column.
  await sql`ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_created_by_fkey`.execute(
    db,
  );
  await sql`
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE CASCADE
  `.execute(db);

  await sql`ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_created_by_fkey`.execute(
    db,
  );
  await sql`
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT
  `.execute(db);
}
