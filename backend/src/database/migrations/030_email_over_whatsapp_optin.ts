import type { Kysely } from 'kysely';
import type { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  // Sending email in response to a WhatsApp request is a NEW, security-relevant capability: email is
  // irreversible and a WhatsApp identity is a weaker factor than a signed-in session. So it is strictly
  // opt-in (approve-to-send), enabled only from a signed-in app with the account password. This column
  // is the switch. Like the other opt-ins it carries a DB-level default of `false`, because the
  // capability must default OFF for every existing row and every new user until they turn it on.
  await db.schema
    .alterTable('user_preferences')
    .addColumn('send_email_over_whatsapp', 'boolean', (col) => col.notNull().defaultTo(false))
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.alterTable('user_preferences').dropColumn('send_email_over_whatsapp').execute();
}
