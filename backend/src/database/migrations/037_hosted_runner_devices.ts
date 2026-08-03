import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * HOSTED runners — the cloud-first path, where Stewra runs the coding-agent container itself instead of
 * the user installing a binary on their laptop.
 *
 * A hosted runner is still a `runner_devices` row and still authenticates with the same device token, so
 * every existing guarantee holds unchanged: the user sees it in the same device list, revokes it the same
 * way, and its sessions route through the same `/runner` namespace. What differs is only WHERE the
 * process lives, and that is exactly the four columns added here — not a second table. A separate table
 * would have forced every device query, every session dispatch, and every revocation path to learn about
 * two kinds of runner, which is how one of them eventually gets forgotten in a security check.
 *
 * `kind` backfills to 'local' for every existing row: a device registered before this migration was
 * paired from a machine we do not own, and nothing here may retroactively claim otherwise.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  // 'local'  — the user's own machine, paired with a single-use code. Stewra can never reach it.
  // 'hosted' — a container Stewra provisioned and can start, stop, and destroy.
  //
  // The distinction is load-bearing beyond bookkeeping: the git-credential endpoint hands out a GitHub
  // installation token, and it is allowed to do that ONLY for a hosted device. Handing one to a laptop
  // would put a credential Stewra minted onto a machine Stewra does not control, breaking the invariant
  // the local path has always kept (the machine's own git credentials, which Stewra never sees).
  await sql`
    ALTER TABLE runner_devices
      ADD COLUMN kind varchar(16) NOT NULL DEFAULT 'local',
      ADD COLUMN container_name varchar(128),
      ADD COLUMN container_status varchar(16),
      ADD COLUMN container_last_started_at timestamptz
  `.execute(db);

  await sql`
    ALTER TABLE runner_devices
      ADD CONSTRAINT runner_devices_kind_check CHECK (kind IN ('local', 'hosted'))
  `.execute(db);

  // `container_status` is what Stewra last SAW of the container (provisioning|starting|running|stopped|
  // failed), refreshed from the provisioner and from the runner's own hello. It is deliberately nullable
  // and deliberately NOT the source of truth — the provisioner's view of Docker is. A stored status that
  // drifted after a host reboot must read as stale-and-correctable, which the hourly reconcile does.
  await sql`
    ALTER TABLE runner_devices
      ADD CONSTRAINT runner_devices_container_status_check
      CHECK (
        container_status IS NULL
        OR container_status IN ('provisioning', 'starting', 'running', 'stopped', 'failed')
      )
  `.execute(db);

  // A local device has no container; a hosted one always has a name (it IS how the provisioner addresses
  // it). Enforced in the database rather than only in the service, because the alternative — a hosted row
  // whose container cannot be named — is a container nothing can ever stop or destroy.
  await sql`
    ALTER TABLE runner_devices
      ADD CONSTRAINT runner_devices_hosted_has_container
      CHECK ((kind = 'hosted') = (container_name IS NOT NULL))
  `.execute(db);

  // ONE hosted runner per user. Partial, so a user may still pair as many laptops as they like — the
  // limit is on what Stewra itself runs and pays for, not on the user's own machines. As a unique index
  // it is enforced under concurrency: two provision requests racing cannot both create a container.
  await sql`
    CREATE UNIQUE INDEX uq_runner_devices_hosted_user
      ON runner_devices (user_id) WHERE kind = 'hosted'
  `.execute(db);

  // The reconcile and idle-stop sweeps both scan hosted rows across all users; without this they are
  // sequential scans of a table whose local rows will always outnumber them.
  await sql`
    CREATE INDEX idx_runner_devices_hosted ON runner_devices (kind) WHERE kind = 'hosted'
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_runner_devices_hosted`.execute(db);
  await sql`DROP INDEX IF EXISTS uq_runner_devices_hosted_user`.execute(db);
  await sql`
    ALTER TABLE runner_devices
      DROP CONSTRAINT IF EXISTS runner_devices_hosted_has_container,
      DROP CONSTRAINT IF EXISTS runner_devices_container_status_check,
      DROP CONSTRAINT IF EXISTS runner_devices_kind_check,
      DROP COLUMN IF EXISTS container_last_started_at,
      DROP COLUMN IF EXISTS container_status,
      DROP COLUMN IF EXISTS container_name,
      DROP COLUMN IF EXISTS kind
  `.execute(db);
}
