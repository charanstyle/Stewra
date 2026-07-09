import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types';

/**
 * Read-receipts + presence + profile-photo groundwork. Three independent schema tweaks that back the
 * WhatsApp-style chat experience:
 *   1. Allow `'avatar'` as a media_assets kind so a profile photo can reuse the existing media store.
 *   2. Give `users` an `avatar_asset_id` pointer to that photo (null = no photo → initials fallback).
 *   3. Add a per-user `read_receipts_enabled` preference (default on) that gates receipt writes/emits.
 * The per-message `message_read_receipts` table already exists (migration 017); this migration only
 * unlocks the surrounding pieces — the write/read paths are pure code.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  // 1. Widen the media_assets.kind CHECK to include profile photos. The inline column check from
  //    migration 021 is auto-named `media_assets_kind_check`; drop and re-add it with 'avatar'.
  await sql`
    ALTER TABLE media_assets DROP CONSTRAINT media_assets_kind_check;
    ALTER TABLE media_assets ADD CONSTRAINT media_assets_kind_check
      CHECK (kind IN ('voice_in', 'tts_out', 'image', 'video', 'audio', 'file', 'avatar'));
  `.execute(db);

  // 2. Point a user at their profile photo. ON DELETE SET NULL so GC'ing the asset just clears the
  //    avatar rather than deleting the user.
  await db.schema
    .alterTable('users')
    .addColumn('avatar_asset_id', 'uuid', (col) =>
      col.references('media_assets.id').onDelete('set null'),
    )
    .execute();

  // 3. Read-receipt sharing toggle. NOT NULL with a DB default so existing rows and omitted inserts
  //    both resolve to "on" (WhatsApp default) without the first-insert friction the older prefs have.
  await db.schema
    .alterTable('user_preferences')
    .addColumn('read_receipts_enabled', 'boolean', (col) => col.notNull().defaultTo(true))
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.alterTable('user_preferences').dropColumn('read_receipts_enabled').execute();
  await db.schema.alterTable('users').dropColumn('avatar_asset_id').execute();
  await sql`
    ALTER TABLE media_assets DROP CONSTRAINT media_assets_kind_check;
    ALTER TABLE media_assets ADD CONSTRAINT media_assets_kind_check
      CHECK (kind IN ('voice_in', 'tts_out', 'image', 'video', 'audio', 'file'));
  `.execute(db);
}
