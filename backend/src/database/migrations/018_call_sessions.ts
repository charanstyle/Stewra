import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  // One row per call attempt, scoped to a conversation. `status` tracks the lifecycle
  // (initiated→ringing→accepted→ended, or declined/missed/failed). `end_reason` records why it stopped.
  // `duration_sec` is filled on finalize. The WebRTC media never touches the server (coturn relays it);
  // this table is the audit/history record only.
  await db.schema
    .createTable('call_sessions')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('conversation_id', 'uuid', (col) =>
      col.notNull().references('conversations.id').onDelete('cascade'),
    )
    .addColumn('initiated_by', 'uuid', (col) =>
      col.notNull().references('users.id').onDelete('cascade'),
    )
    .addColumn('call_type', 'varchar(16)', (col) =>
      col.notNull().check(sql`call_type in ('audio', 'video')`),
    )
    .addColumn('status', 'varchar(16)', (col) =>
      col
        .notNull()
        .defaultTo('initiated')
        .check(
          sql`status in ('initiated', 'ringing', 'accepted', 'declined', 'ended', 'failed', 'missed')`,
        ),
    )
    .addColumn('started_at', 'timestamptz')
    .addColumn('ended_at', 'timestamptz')
    .addColumn('duration_sec', 'integer')
    .addColumn('end_reason', 'varchar(16)', (col) =>
      col.check(
        sql`end_reason is null or end_reason in ('hangup', 'declined', 'missed', 'failed', 'cancelled', 'timeout')`,
      ),
    )
    .addColumn('metadata', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex('idx_call_sessions_conversation')
    .on('call_sessions')
    .column('conversation_id')
    .execute();

  // Per-participant call state (join/leave times, live audio/video enable flags). Enables group calls
  // (RankRise mesh): one row per user in the call. Unique (call, user).
  await db.schema
    .createTable('call_participants')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('call_id', 'uuid', (col) =>
      col.notNull().references('call_sessions.id').onDelete('cascade'),
    )
    .addColumn('user_id', 'uuid', (col) => col.notNull().references('users.id').onDelete('cascade'))
    .addColumn('joined_at', 'timestamptz')
    .addColumn('left_at', 'timestamptz')
    .addColumn('audio_enabled', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('video_enabled', 'boolean', (col) => col.notNull().defaultTo(false))
    .addUniqueConstraint('uq_call_participant_call_user', ['call_id', 'user_id'])
    .execute();

  await db.schema
    .createIndex('idx_call_participants_call')
    .on('call_participants')
    .column('call_id')
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('call_participants').execute();
  await db.schema.dropTable('call_sessions').execute();
}
