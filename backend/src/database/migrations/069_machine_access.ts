import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * Let Stewra tell which computer a bridge and a runner are both sitting on, and give a bridge that cannot
 * see its own machine a way to ask.
 *
 * THE FAILURE THIS ENDS. Bridge devices are user-scoped; runner devices are org-scoped. So a Stewra Bridge
 * could be running on the very Mac a runner was paired from, be asked "what's running on the Mac mini?",
 * and answer "I don't have a machine called that" — correct about tenancy, useless to the person holding
 * the phone, and with no route from the dead end to permission. Nothing in either hello said which box it
 * was on: the bridge sent `{appVersion, waState}` and the runner sent `os` plus a display name each derived
 * differently. `host_id` is the missing fact.
 *
 * `host_id` is `sha256(kind + ':' + value)` computed HERE, on the server, from what the client reported
 * reading (see packages/shared-types/src/realtime/hostIdentity.ts). Hashed at rest because a hardware UUID
 * is a durable identifier for someone's physical computer and there is no reason for this table to hold the
 * plaintext; server-side because one implementation of the matching rule cannot drift from itself. Nullable
 * on both device tables, and that nullability is load-bearing: NULL means "this build never told us" or
 * "this platform has no identifier we read", NOT "no match" — so nothing may treat two NULLs as the same
 * machine.
 *
 * `machine_access_requests` is the route from the dead end. One row is both the request and, once approved,
 * the grant; a denial is recorded rather than left as silence, so a refused bridge can be told it was
 * refused instead of asking again forever. What approval grants is deliberately narrow — see the model
 * docblock in shared-types: the asker may SEE that one machine, and may not start sessions on it.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await sql`
    ALTER TABLE bridge_devices
      ADD COLUMN host_id char(64),
      ADD COLUMN hostname varchar(255)
  `.execute(db);
  await sql`
    ALTER TABLE runner_devices
      ADD COLUMN host_id char(64),
      ADD COLUMN hostname varchar(255)
  `.execute(db);
  await sql`CREATE INDEX idx_bridge_devices_host ON bridge_devices (host_id)`.execute(db);
  await sql`CREATE INDEX idx_runner_devices_host ON runner_devices (host_id)`.execute(db);

  await sql`
    CREATE TABLE machine_access_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      device_id uuid NOT NULL REFERENCES runner_devices(id) ON DELETE CASCADE,
      -- Snapshotted so a decided request still reads sensibly after a rename.
      device_name varchar(64) NOT NULL,
      bridge_device_id uuid NOT NULL REFERENCES bridge_devices(id) ON DELETE CASCADE,
      requested_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      requested_by_name varchar(120) NOT NULL,
      hostname varchar(255) NOT NULL,
      host_id char(64) NOT NULL,
      status varchar(16) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'denied')),
      requested_at timestamptz NOT NULL DEFAULT now(),
      decided_at timestamptz,
      decided_by uuid REFERENCES users(id) ON DELETE SET NULL
    )
  `.execute(db);

  // One open ask per person per machine. Without this, every reconnect of a bridge that cannot see its
  // machine would file another request and bury the org's admins in identical rows.
  await sql`
    CREATE UNIQUE INDEX uq_machine_access_open
      ON machine_access_requests (device_id, requested_by_user_id)
      WHERE status = 'pending'
  `.execute(db);
  await sql`
    CREATE INDEX idx_machine_access_org
      ON machine_access_requests (org_id, status, requested_at DESC)
  `.execute(db);
  // The read on the answering path: "may this person see this machine?"
  await sql`
    CREATE INDEX idx_machine_access_grant
      ON machine_access_requests (requested_by_user_id, device_id, status)
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`DROP TABLE IF EXISTS machine_access_requests`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_runner_devices_host`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_bridge_devices_host`.execute(db);
  await sql`ALTER TABLE runner_devices DROP COLUMN IF EXISTS hostname`.execute(db);
  await sql`ALTER TABLE runner_devices DROP COLUMN IF EXISTS host_id`.execute(db);
  await sql`ALTER TABLE bridge_devices DROP COLUMN IF EXISTS hostname`.execute(db);
  await sql`ALTER TABLE bridge_devices DROP COLUMN IF EXISTS host_id`.execute(db);
}
