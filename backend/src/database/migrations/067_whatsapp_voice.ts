import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * Voice over the WhatsApp bridge.
 *
 * A person can now talk to Stewra by sending a voice note to their own "Message yourself" chat. The
 * bridge forwards the audio, the server transcribes it, and — because they spoke — Stewra answers with a
 * voice note AND the same words as text, so they can listen or read.
 *
 * Two facts need a home:
 *
 *  - `whatsapp_messages.is_voice`: whether a stored message was spoken. It is what decides the medium of
 *    the next UNSOLICITED line (a runner asking for permission minutes later): if the person's latest
 *    message to Stewra was a voice note, that line is voiced too.
 *  - `whatsapp_outbound.audio_asset_id`: the OGG/Opus clip a queued send delivers as a voice note. Null
 *    for an ordinary text send. The body stays the spoken words, so the outbox reads the same either way.
 *    The reference is NOT `ON DELETE SET NULL`: silently turning a queued voice note into a text message
 *    would be exactly the kind of quiet downgrade this codebase refuses. A clip cannot be deleted while a
 *    send still names it; account deletion removes both in one statement, which the default deferred
 *    check allows.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await sql`ALTER TABLE whatsapp_messages ADD COLUMN is_voice boolean NOT NULL DEFAULT false`.execute(db);
  await sql`
    ALTER TABLE whatsapp_outbound
      ADD COLUMN audio_asset_id uuid REFERENCES media_assets(id)
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`ALTER TABLE whatsapp_outbound DROP COLUMN IF EXISTS audio_asset_id`.execute(db);
  await sql`ALTER TABLE whatsapp_messages DROP COLUMN IF EXISTS is_voice`.execute(db);
}
