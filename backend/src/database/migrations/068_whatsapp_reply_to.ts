import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * Stewra's lines in the self-chat quote the message they answer.
 *
 * In "Message yourself" every bubble — the person's and Stewra's alike — is sent from the same account,
 * so WhatsApp draws them all on the same side in the same colour. Two voice notes in a row give no clue
 * which one was spoken by whom. Sending Stewra's reply as a WhatsApp *reply* (a quoted message) is the
 * one rendering primitive that tells them apart on every client, for text and voice notes both.
 *
 * `whatsapp_outbound.reply_to_provider_message_id` is the Baileys `key.id` of the person's message a
 * queued send answers. Null for a line that answers nothing in particular (nothing of theirs stored yet).
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await sql`
    ALTER TABLE whatsapp_outbound
      ADD COLUMN reply_to_provider_message_id varchar(255)
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`ALTER TABLE whatsapp_outbound DROP COLUMN IF EXISTS reply_to_provider_message_id`.execute(db);
}
