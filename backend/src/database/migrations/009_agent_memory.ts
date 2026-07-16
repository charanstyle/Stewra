import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * The user-owned, named, searchable memory. Each row is a "learning" the control plane derives
 * (deterministically) from a user's feedback: `exemplar` is the high-rated advice ("what good looks
 * like"), `guidance` is distilled from the free-text ("how to do it"), and `label` is the
 * human-meaningful NAME both the model and lexical search key on.
 *
 * Retrieval is pure lexical: a generated `search_vector` (Postgres full-text over label+purpose+
 * guidance) with a GIN index, plus a pg_trgm index on `label` for fuzzy name lookups in the UI.
 * Written in raw SQL because the generated tsvector column isn't expressible in Kysely's schema
 * builder. Rows are really deletable (memory-and-learning.md §5) — no soft-delete.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`.execute(db);

  await sql`
    CREATE TABLE agent_memory (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label varchar(200) NOT NULL,
      kind varchar(32) NOT NULL,
      purpose text NOT NULL,
      purpose_norm text NOT NULL,
      exemplar text NOT NULL,
      guidance text,
      rating varchar(16) NOT NULL,
      reward_score integer NOT NULL,
      source varchar(16) NOT NULL DEFAULT 'feedback',
      source_insight_id uuid REFERENCES agent_insights(id) ON DELETE SET NULL,
      visible boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      search_vector tsvector GENERATED ALWAYS AS (
        to_tsvector('english',
          coalesce(label, '') || ' ' || coalesce(purpose, '') || ' ' || coalesce(guidance, ''))
      ) STORED
    )
  `.execute(db);

  // One learning per rated insight — re-rating the same insight updates the same row (upsert target).
  await sql`
    CREATE UNIQUE INDEX uq_agent_memory_user_source
      ON agent_memory (user_id, source_insight_id)
  `.execute(db);

  // Lexical recall: full-text over the searchable text, scoped-list by (user, kind), fuzzy by name.
  await sql`CREATE INDEX idx_agent_memory_search ON agent_memory USING gin (search_vector)`.execute(
    db,
  );
  await sql`CREATE INDEX idx_agent_memory_user_kind ON agent_memory (user_id, kind)`.execute(db);
  await sql`CREATE INDEX idx_agent_memory_label_trgm ON agent_memory USING gin (label gin_trgm_ops)`.execute(
    db,
  );
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('agent_memory').execute();
}
