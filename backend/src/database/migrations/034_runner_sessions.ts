import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * A coding session hosted by a Stewra Runner: one agent run (Claude Code / Codex / Gemini) against one of
 * the user's repositories, on one of their machines. The row is the server's durable record of a session's
 * existence and lifecycle — who ran what, where, and how it ended — while the actual work happens on the
 * user's box inside a throwaway git worktree.
 *
 * Sibling of `runner_devices` (migration 033). Additive and reversible.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  // `id` is the server-minted session id that also travels on the wire (`runner:start-session`), so the
  // runner's streamed updates map straight back to this row without a translation table.
  //
  // `device_id` is intentionally NOT a foreign key. Revoking a device DELETES its `runner_devices` row (no
  // soft-delete, by design), but a session it once ran must remain in the history — an FK with CASCADE
  // would erase exactly the audit trail we want to keep, and one with RESTRICT would block revocation. So
  // we store the id as a plain uuid and snapshot `device_name`/`workspace_name` for display, the same way
  // the append-only audit_log preserves facts about rows that later vanish.
  //
  // `status` mirrors the RUNNER_SESSION_STATUSES union in shared-types; kept as text (not a PG enum) so a
  // new lifecycle state ships with a code change, not a migration — consistent with the rest of the schema.
  await sql`
    CREATE TABLE runner_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_id uuid NOT NULL,
      device_name varchar(64) NOT NULL DEFAULT '',
      harness varchar(32) NOT NULL,
      workspace_id varchar(128) NOT NULL,
      workspace_name varchar(128) NOT NULL DEFAULT '',
      status varchar(32) NOT NULL,
      prompt text NOT NULL,
      summary text,
      error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz
    )
  `.execute(db);
  // The Runners UI lists a user's sessions newest-first; index the access path rather than scan.
  await sql`CREATE INDEX idx_runner_sessions_user ON runner_sessions (user_id, created_at DESC)`.execute(db);
  // "What is this machine currently running?" — the addressed-dispatch view needs sessions by device.
  await sql`CREATE INDEX idx_runner_sessions_device ON runner_sessions (device_id)`.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('runner_sessions').execute();
}
