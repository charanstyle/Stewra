import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * The proactive-assistant output store. `briefings` holds one current natural-language "here's your
 * day" per user (upserted each run). `suggestions` holds the nudges — Stewra's "here's something that
 * needs attention, and what you could do". A `dedup_key` (e.g. "needs_reply:<threadId>") gives each
 * nudge a stable identity so a re-computation UPDATES the open one in place rather than duplicating —
 * and, crucially, never clobbers one the user has already acted on (dismissed/snoozed/done), keeping
 * the propose→confirm guarantee (same spirit as process_memory's isSilentClobber).
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await sql`
    CREATE TABLE briefings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      summary text NOT NULL DEFAULT '',
      sections jsonb NOT NULL DEFAULT '[]',
      generated_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE TABLE suggestions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      dedup_key varchar(255) NOT NULL,
      kind varchar(32) NOT NULL,
      title text NOT NULL,
      rationale text NOT NULL DEFAULT '',
      source_refs jsonb NOT NULL DEFAULT '[]',
      options jsonb NOT NULL DEFAULT '[]',
      status varchar(16) NOT NULL DEFAULT 'open',
      snoozed_until timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX uq_suggestions_user_dedup ON suggestions (user_id, dedup_key)`.execute(
    db,
  );
  await sql`CREATE INDEX idx_suggestions_user_status ON suggestions (user_id, status)`.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('suggestions').execute();
  await db.schema.dropTable('briefings').execute();
}
