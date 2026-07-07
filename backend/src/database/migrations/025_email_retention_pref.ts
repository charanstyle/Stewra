import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types';

/**
 * The durable per-user email retention window (days). How far back Stewra keeps synced mail — default
 * 90, user-adjustable up to "all history". Nullable: NULL means "the user hasn't chosen", and the
 * preferences service resolves it to the deploy default (config.emailSync.retentionDefaultDays),
 * exactly like `gmail_lookback_days`. The sync engine enforces the resolved window.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await sql`ALTER TABLE user_preferences ADD COLUMN email_retention_days integer`.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`ALTER TABLE user_preferences DROP COLUMN email_retention_days`.execute(db);
}
