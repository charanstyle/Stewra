import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * Git follow-through columns for `runner_sessions` (migration 034).
 *
 * Phase 2 recorded a session's existence and outcome; Phase 3 lets a finished session's work become a
 * reviewable, mergeable object on the user's machine — committed to an isolated branch, then pushed and
 * turned into a PR at the user's request. These four columns are the server's durable record of that
 * follow-through:
 *
 *   - `branch`   — the isolated branch the runner committed the work onto (`stewra/run/<id>`).
 *   - `head_sha` — the branch's tip after the runner's auto-commit, so the reviewable output is unambiguous.
 *   - `pushed`   — whether that branch has reached its remote.
 *   - `pr_url`   — the pull request, once opened.
 *
 * All nullable/defaulted so this is purely additive over existing rows (a mid-run session simply has none
 * yet), and reversible — `down()` drops exactly what `up()` adds. Consistent with 034: no FKs to volatile
 * device rows, plain text/bool rather than enums, snapshot rather than join.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await sql`
    ALTER TABLE runner_sessions
      ADD COLUMN branch varchar(255),
      ADD COLUMN head_sha varchar(64),
      ADD COLUMN pr_url text,
      ADD COLUMN pushed boolean NOT NULL DEFAULT false
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`
    ALTER TABLE runner_sessions
      DROP COLUMN branch,
      DROP COLUMN head_sha,
      DROP COLUMN pr_url,
      DROP COLUMN pushed
  `.execute(db);
}
