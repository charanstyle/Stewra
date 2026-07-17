import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * Android now registers a RAW FCM device token (not an Expo token). The approve-to-send prompt has to be
 * sent data-only so its Approve/Deny buttons render when the app is backgrounded — Expo push always
 * delivers notification-type on Android, which the OS auto-displays with no buttons (confirmed on-device
 * 2026-07-17). Raw FCM v1 data-only needs the FCM device token. iOS keeps its Expo token.
 *
 * So a row carries EITHER an Expo token (iOS) or an FCM token (Android): make `expo_token` nullable, add
 * `fcm_token`, and require at least one to be present. Additive and backward-compatible — existing iOS
 * rows keep their Expo token untouched.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await sql`ALTER TABLE push_tokens ADD COLUMN fcm_token text`.execute(db);
  await sql`ALTER TABLE push_tokens ALTER COLUMN expo_token DROP NOT NULL`.execute(db);
  await sql`
    ALTER TABLE push_tokens
    ADD CONSTRAINT push_tokens_token_present
    CHECK (expo_token IS NOT NULL OR fcm_token IS NOT NULL)
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`ALTER TABLE push_tokens DROP CONSTRAINT IF EXISTS push_tokens_token_present`.execute(db);
  // Restoring NOT NULL would fail on any Android-only (fcm-only) row, so drop those first. They are just
  // device tokens — the device re-registers on next launch — so this loses nothing durable.
  await db.deleteFrom('push_tokens').where('expo_token', 'is', null).execute();
  await sql`ALTER TABLE push_tokens ALTER COLUMN expo_token SET NOT NULL`.execute(db);
  await sql`ALTER TABLE push_tokens DROP COLUMN fcm_token`.execute(db);
}
