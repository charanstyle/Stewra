import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * The runner plane becomes org-owned.
 *
 * Until now a runner device, its pairing codes and its sessions belonged to a USER. Every account is
 * now a tenant (063), and the machines and sessions a business runs are the business's — a teammate
 * must be able to start a session on the company's Mac mini, and the founder's personal laptop must
 * not appear in the company's fleet. So `org_id` is added to all three tables, backfilled, and made
 * NOT NULL. There is no nullable "personal" case: one scope, one code path.
 *
 * `user_id` STAYS, and stays NOT NULL. On a device it means "who paired this machine"; on a session,
 * "which member started this run". Those are different questions from "whose is it", and neither
 * column replaces the other.
 *
 * Backfill rule, per user: their `individual` org if they have one, else the oldest org they own.
 * After 063 every user owns at least one org, so the assignment is total; it is unambiguous for every
 * user who existed before organizations did (exactly one individual org) and deterministic for the
 * handful who created a business org before this migration (the oldest one). Moving a machine to a
 * different org afterwards is a UI action — `POST /orgs/:orgId/runner/devices/:id/move`.
 *
 * Also here, because it is a property of a device and nothing else: `environment`. The user labels a
 * machine `development` or `production` in the fleet UI, and a production machine gates session
 * starts behind a typed confirmation. Every machine starts as `development` — a declared starting
 * state for a user-edited label, chosen so that nothing is gated until a person says it should be.
 *
 * `UNIQUE (id, org_id)` on `runner_devices` exists for 065: a composite foreign key from a workspace
 * binding to `(device_id, org_id)` is how the database — not only the service — refuses a binding
 * that would put a machine from one tenant under a project from another.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  // --- org_id, nullable for the length of the backfill -------------------------------------------
  await sql`ALTER TABLE runner_devices ADD COLUMN org_id uuid REFERENCES organizations(id) ON DELETE CASCADE`.execute(db);
  await sql`ALTER TABLE runner_pair_codes ADD COLUMN org_id uuid REFERENCES organizations(id) ON DELETE CASCADE`.execute(db);
  await sql`ALTER TABLE runner_sessions ADD COLUMN org_id uuid REFERENCES organizations(id) ON DELETE CASCADE`.execute(db);

  // --- backfill from the owner's org, individual first, oldest otherwise --------------------------
  // One CTE, reused three times, so the rule cannot drift between the tables.
  for (const table of ['runner_devices', 'runner_pair_codes', 'runner_sessions'] as const) {
    await sql`
      WITH home AS (
        SELECT DISTINCT ON (m.user_id)
          m.user_id,
          m.org_id
        FROM org_members m
        JOIN organizations o ON o.id = m.org_id
        WHERE m.role = 'owner'
        ORDER BY m.user_id, (o.kind = 'individual') DESC, o.created_at ASC
      )
      UPDATE ${sql.table(table)} t
      SET org_id = home.org_id
      FROM home
      WHERE t.user_id = home.user_id AND t.org_id IS NULL
    `.execute(db);
  }

  // The backfill is total by construction (063 gave every user an owned org). If it is not — a row
  // whose user somehow owns nothing — this fails the migration rather than leaving a NULL scope
  // behind, which is the outcome the whole design exists to prevent.
  await sql`ALTER TABLE runner_devices ALTER COLUMN org_id SET NOT NULL`.execute(db);
  await sql`ALTER TABLE runner_pair_codes ALTER COLUMN org_id SET NOT NULL`.execute(db);
  await sql`ALTER TABLE runner_sessions ALTER COLUMN org_id SET NOT NULL`.execute(db);

  // --- access paths: the fleet lists devices and sessions by org ------------------------------------
  await sql`CREATE INDEX idx_runner_devices_org ON runner_devices (org_id)`.execute(db);
  await sql`CREATE INDEX idx_runner_pair_codes_org ON runner_pair_codes (org_id)`.execute(db);
  await sql`CREATE INDEX idx_runner_sessions_org ON runner_sessions (org_id, created_at DESC)`.execute(db);

  // --- the composite key 065's bindings point at ---------------------------------------------------
  await sql`ALTER TABLE runner_devices ADD CONSTRAINT uq_runner_devices_id_org UNIQUE (id, org_id)`.execute(db);

  // --- environment ----------------------------------------------------------------------------------
  await sql`
    ALTER TABLE runner_devices
      ADD COLUMN environment varchar(16) NOT NULL DEFAULT 'development'
      CHECK (environment IN ('development', 'production'))
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`ALTER TABLE runner_devices DROP COLUMN IF EXISTS environment`.execute(db);
  await sql`ALTER TABLE runner_devices DROP CONSTRAINT IF EXISTS uq_runner_devices_id_org`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_runner_sessions_org`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_runner_pair_codes_org`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_runner_devices_org`.execute(db);
  await sql`ALTER TABLE runner_sessions DROP COLUMN IF EXISTS org_id`.execute(db);
  await sql`ALTER TABLE runner_pair_codes DROP COLUMN IF EXISTS org_id`.execute(db);
  await sql`ALTER TABLE runner_devices DROP COLUMN IF EXISTS org_id`.execute(db);
}
