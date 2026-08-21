import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * Every account is a tenant.
 *
 * Until now an organization was something a person created on the commerce page if they ran a
 * business, and everyone else had none. Projects and runner machines are about to be org-owned, and
 * a nullable scope ("org_id, or the user_id when there is no org") is the single most dangerous line
 * a tenancy layer can contain — one `undefined` and a query reads across tenants. So the nullable
 * case is removed at the root: every user gets an organization, and `org_id` can be NOT NULL
 * everywhere it appears.
 *
 * Three things, in order:
 *
 *  1. `organizations.kind` — `individual` or `business`, CHECK-constrained, NO default. Every insert
 *     says which it is. Existing rows are all `business`: each was created deliberately, by name, on
 *     the commerce page, which is the business path.
 *
 *  2. One `individual` org per existing user who owns none, plus its `owner` membership, named from
 *     `users.display_name`. Deterministic, idempotent migration work, not a hand-run UPDATE: re-running
 *     it finds every user already owning an org and inserts nothing. The slug is the slugified name
 *     plus the first eight characters of the user id, which cannot collide across users and never
 *     needs the application's random-suffix collision loop.
 *
 *  3. A trigger refusing `org_invites` rows for an `individual` org. The org IS the person; an invite
 *     into it would quietly turn a personal account into a team without the explicit "convert"
 *     action. The service checks the same thing and gives a readable error; this is the guarantee
 *     behind it, and it holds for any code path — including a future one nobody has written yet.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  // --- 1. kind ---------------------------------------------------------------------------------
  // Added with a temporary default so existing rows are valid, then the default is dropped so every
  // future INSERT must state the kind. Two statements rather than one deliberately: the default
  // exists for exactly as long as the backfill needs it.
  await sql`
    ALTER TABLE organizations
      ADD COLUMN kind varchar(16) NOT NULL DEFAULT 'business'
      CHECK (kind IN ('individual', 'business'))
  `.execute(db);
  await sql`ALTER TABLE organizations ALTER COLUMN kind DROP DEFAULT`.execute(db);

  // --- 2. one individual org per user who owns nothing ------------------------------------------
  // "Owns" is `role = 'owner'`, not mere membership: a person invited into a client's org as an
  // agent still has no organization of their own to put a project in.
  //
  // The slug rule mirrors `slugify()` in organizationRepository (NFKD is not available in SQL, so
  // accented letters become hyphens here where the application would strip the accent; both are
  // valid handles and the suffix keeps them unique). An empty base — a display name of pure
  // punctuation — becomes `user-<id8>`.
  await sql`
    WITH unowned AS (
      SELECT u.id, u.display_name
      FROM users u
      WHERE NOT EXISTS (
        SELECT 1 FROM org_members m WHERE m.user_id = u.id AND m.role = 'owner'
      )
    ),
    created AS (
      INSERT INTO organizations (name, slug, kind, created_by)
      SELECT
        display_name,
        CASE
          WHEN base = '' THEN 'user-' || left(id::text, 8)
          ELSE left(base, 48) || '-' || left(id::text, 8)
        END,
        'individual',
        id
      FROM (
        SELECT
          id,
          display_name,
          trim(both '-' from regexp_replace(lower(display_name), '[^a-z0-9]+', '-', 'g')) AS base
        FROM unowned
      ) named
      RETURNING id AS org_id, created_by AS user_id
    )
    INSERT INTO org_members (org_id, user_id, role)
    SELECT org_id, user_id, 'owner' FROM created
  `.execute(db);

  // --- 3. individual orgs refuse invites ------------------------------------------------------
  await sql`
    CREATE OR REPLACE FUNCTION stewra_org_invites_business_only()
    RETURNS trigger AS $$
    DECLARE
      org_kind text;
    BEGIN
      SELECT kind INTO org_kind FROM organizations WHERE id = NEW.org_id;
      IF org_kind = 'individual' THEN
        RAISE EXCEPTION 'organization % is an individual account and cannot be invited into; convert it to a business organization first', NEW.org_id;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);
  await sql`
    CREATE TRIGGER trg_org_invites_business_only
      BEFORE INSERT ON org_invites
      FOR EACH ROW EXECUTE FUNCTION stewra_org_invites_business_only()
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS trg_org_invites_business_only ON org_invites`.execute(db);
  await sql`DROP FUNCTION IF EXISTS stewra_org_invites_business_only()`.execute(db);
  // The provisioned individual orgs are NOT removed: by the time this runs they may own projects and
  // machines, and a down migration that destroys tenant data is not a rollback. They simply become
  // ordinary organizations again once the column goes.
  await sql`ALTER TABLE organizations DROP COLUMN kind`.execute(db);
}
