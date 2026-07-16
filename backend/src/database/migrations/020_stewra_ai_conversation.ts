import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

export async function up(db: Kysely<Database>): Promise<void> {
  // Guarantee at most one Stewra-AI conversation per user. For a `type='stewra_ai'` conversation the
  // creator IS the sole human participant, so a partial unique index on `created_by` (scoped to that
  // type) is the singleton guarantee — get-or-create can race two requests and the DB rejects the second.
  // The assistant is NOT a users row: its turns are messages with sender_id=null, sender_kind='assistant'.
  await sql`
    CREATE UNIQUE INDEX uq_stewra_ai_conversation_per_user
      ON conversations (created_by)
      WHERE type = 'stewra_ai'
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`DROP INDEX IF EXISTS uq_stewra_ai_conversation_per_user`.execute(db);
}
