import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * Record which OAuth scopes a connection was actually GRANTED. Before this, connections carried no
 * scope set, so the backend could not tell a read-only grant (made before Stewra requested write
 * access) from a full one. The proactive assistant needs full mail read + modify/send; a connection
 * missing those is flagged `needsReconsent` and prompted to reconnect.
 *
 * Existing rows get '' (an empty, comma-joined set) — correctly detected as needing re-consent since
 * it lacks the write scopes.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await sql`ALTER TABLE connections ADD COLUMN scopes text NOT NULL DEFAULT ''`.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`ALTER TABLE connections DROP COLUMN scopes`.execute(db);
}
