import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types';

/**
 * The email store: the first place Stewra persists real inbox content, so it can summarise the inbox,
 * detect "who you owe a reply", and understand the full history with a contact. Message BODIES are
 * encrypted at rest with the same AES-256-GCM strength as the vault (via fieldCrypto), stored inline
 * in `body_ciphertext` — never plaintext. A concrete contact address is vaulted (only its handle +
 * a hash live here), mirroring the `process_memory` identifying-contact pattern. Everything is
 * user-scoped and CASCADE-deletes on user/connection removal; the retention sweep expires rows past
 * the user's window. Bodies live only in the control plane and never reach the agent runtime.
 *
 * Gmail ids (message/thread/history) are stored as varchar, not bigint, so a large uint64 historyId
 * can never lose precision through a JS number.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  // People the user corresponds with. The plaintext address is vaulted; `address_sha256` lets sync
  // dedupe/lookup a contact without holding the plaintext on the row.
  await sql`
    CREATE TABLE email_contacts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
      address_vault_ref varchar(255) NOT NULL,
      address_sha256 char(64) NOT NULL,
      display_name text NOT NULL DEFAULT '',
      first_seen_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      message_count integer NOT NULL DEFAULT 0,
      last_inbound_at timestamptz,
      last_outbound_at timestamptz,
      awaiting_reply boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX uq_email_contacts_conn_addr
      ON email_contacts (connection_id, address_sha256)
  `.execute(db);
  await sql`CREATE INDEX idx_email_contacts_user_awaiting ON email_contacts (user_id, awaiting_reply)`.execute(
    db,
  );

  // Conversation threads. `awaiting_reply` = the latest message is inbound and unanswered.
  await sql`
    CREATE TABLE email_threads (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
      gmail_thread_id varchar(255) NOT NULL,
      subject text NOT NULL DEFAULT '',
      last_message_at timestamptz,
      participant_contact_ids jsonb NOT NULL DEFAULT '[]',
      has_unread boolean NOT NULL DEFAULT false,
      awaiting_reply boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX uq_email_threads_conn_gmail
      ON email_threads (connection_id, gmail_thread_id)
  `.execute(db);
  await sql`CREATE INDEX idx_email_threads_user_last ON email_threads (user_id, last_message_at)`.execute(
    db,
  );

  // Individual messages, body encrypted at rest. `direction` is inbound/outbound relative to the user.
  await sql`
    CREATE TABLE email_messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
      thread_id uuid NOT NULL REFERENCES email_threads(id) ON DELETE CASCADE,
      gmail_message_id varchar(255) NOT NULL,
      gmail_history_id varchar(255),
      from_contact_id uuid REFERENCES email_contacts(id) ON DELETE SET NULL,
      direction varchar(8) NOT NULL,
      sent_at timestamptz,
      subject text NOT NULL DEFAULT '',
      snippet text NOT NULL DEFAULT '',
      body_ciphertext text NOT NULL DEFAULT '',
      label_ids jsonb NOT NULL DEFAULT '[]',
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX uq_email_messages_conn_gmail
      ON email_messages (connection_id, gmail_message_id)
  `.execute(db);
  await sql`CREATE INDEX idx_email_messages_thread ON email_messages (thread_id)`.execute(db);
  await sql`CREATE INDEX idx_email_messages_user_sent ON email_messages (user_id, sent_at)`.execute(
    db,
  );
  await sql`CREATE INDEX idx_email_messages_contact ON email_messages (from_contact_id)`.execute(db);

  // One sync-state row per connection, driving resumable backfill + incremental history.list.
  await sql`
    CREATE TABLE email_sync_state (
      connection_id uuid PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      last_history_id varchar(255),
      backfill_cursor text,
      backfill_complete boolean NOT NULL DEFAULT false,
      last_synced_at timestamptz,
      retention_days integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('email_sync_state').execute();
  await db.schema.dropTable('email_messages').execute();
  await db.schema.dropTable('email_threads').execute();
  await db.schema.dropTable('email_contacts').execute();
}
