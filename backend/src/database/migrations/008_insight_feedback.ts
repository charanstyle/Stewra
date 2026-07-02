import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  // One row per (user, insight) verdict. `rating` is the 5-level scale; `reward_score` is the derived
  // scalar (Sutton's reward hypothesis, kept for analytics/ordering); `comment` is the optional
  // free-text. The unique (user_id, insight_id) lets the user change their mind — the repository
  // upserts, so the latest verdict wins rather than piling up duplicates.
  await db.schema
    .createTable('insight_feedback')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('user_id', 'uuid', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('insight_id', 'uuid', (col) =>
      col.notNull().references('agent_insights.id').onDelete('cascade'),
    )
    .addColumn('rating', 'varchar(16)', (col) => col.notNull())
    .addColumn('reward_score', 'integer', (col) => col.notNull())
    .addColumn('comment', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addUniqueConstraint('uq_insight_feedback_user_insight', ['user_id', 'insight_id'])
    .execute();

  await db.schema
    .createIndex('idx_insight_feedback_insight_id')
    .on('insight_feedback')
    .column('insight_id')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('insight_feedback').execute();
}
