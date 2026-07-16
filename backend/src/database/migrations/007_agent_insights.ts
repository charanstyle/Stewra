import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

export async function up(db: Kysely<Database>): Promise<void> {
  // One row per insight the agent produces. Persisting it (rather than only logging it to the audit
  // trail) gives each insight a stable id feedback can attach to, and keeps the trajectory — purpose,
  // advice, model — that a positive rating later turns into a reusable exemplar. Only DERIVED content
  // is stored (the purpose label and the advice sentence); raw records never reach this table.
  await db.schema
    .createTable('agent_insights')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('user_id', 'uuid', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('kind', 'varchar(32)', (col) => col.notNull())
    .addColumn('purpose', 'text', (col) => col.notNull())
    // Normalized purpose (lowercased, punctuation-stripped) — the handle lexical recall matches on.
    .addColumn('purpose_norm', 'text', (col) => col.notNull())
    .addColumn('summary', 'text', (col) => col.notNull())
    // '' for claude_cli (the user's own configured model); the concrete id for API providers.
    .addColumn('model_id', 'varchar(128)', (col) => col.notNull().defaultTo(''))
    // Reserved for richer trajectory capture (the derived facts that fed the model). Null for now.
    .addColumn('facts_used', 'jsonb')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex('idx_agent_insights_user_id')
    .on('agent_insights')
    .column('user_id')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('agent_insights').execute();
}
