import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * Process & style memory — the user-owned store of *how* they like work done (the "process"),
 * deliberately never the *what* (the content). Where `agent_memory` (009) is task-scoped and
 * episodic — one exemplar per rated insight — this table holds GENERALIZED, cross-task rules
 * ("Opens warm, then states the ask within two sentences"). It is the concrete implementation of
 * the derived-facts / profile tier named in memory-and-learning.md §1.
 *
 * Trust machinery mirrors `agent_memory`: fully visible/editable, really deletable (no soft-delete),
 * audited, and forgettable on disconnect (via `derived_from_provider`). The model may only
 * PROPOSE rules (`status='proposed'`, source `observed`/`feedback`) — it never writes an active rule
 * silently (§3). Rules that reference a real person are stored by ROLE (`subject_role`); a concrete
 * identity that can't be generalized is encrypted in the vault, and only its handle
 * (`subject_vault_ref`) lives here — never a plaintext contact.
 *
 * Written in raw SQL because the generated `search_vector` tsvector isn't expressible in Kysely's
 * schema builder (same reason as 009). `pg_trgm` is already created by 009.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await sql`
    CREATE TABLE process_memory (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      domain varchar(32) NOT NULL,
      dimension varchar(32) NOT NULL,
      rule text NOT NULL,
      tier varchar(16) NOT NULL DEFAULT 'style',
      subject_role varchar(64),
      subject_vault_ref varchar(255),
      status varchar(16) NOT NULL DEFAULT 'proposed',
      source varchar(16) NOT NULL DEFAULT 'observed',
      confidence integer NOT NULL DEFAULT 0,
      support_count integer NOT NULL DEFAULT 0,
      reward_score integer NOT NULL DEFAULT 0,
      derived_from_provider varchar(64),
      visible boolean NOT NULL DEFAULT true,
      last_reinforced_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      search_vector tsvector GENERATED ALWAYS AS (
        to_tsvector('english',
          coalesce(domain, '') || ' ' || coalesce(dimension, '') || ' ' || coalesce(rule, ''))
      ) STORED
    )
  `.execute(db);

  // One rule per (user, domain, dimension, subject) — re-observing/updating the same axis upserts in
  // place. COALESCE the nullable role so style rules (no role) still collapse to one row per axis
  // rather than Postgres treating every NULL as distinct.
  await sql`
    CREATE UNIQUE INDEX uq_process_memory_user_axis
      ON process_memory (user_id, domain, dimension, coalesce(subject_role, ''))
  `.execute(db);

  // Lexical recall over the rule text; scoped list by (user, domain, status); fuzzy by rule text.
  await sql`CREATE INDEX idx_process_memory_search ON process_memory USING gin (search_vector)`.execute(
    db,
  );
  await sql`CREATE INDEX idx_process_memory_user_domain_status ON process_memory (user_id, domain, status)`.execute(
    db,
  );
  await sql`CREATE INDEX idx_process_memory_rule_trgm ON process_memory USING gin (rule gin_trgm_ops)`.execute(
    db,
  );
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('process_memory').execute();
}
