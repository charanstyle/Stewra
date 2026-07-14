import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types';

/**
 * The EXPERIMENTAL `whatsapp_personal` channel — the user's OWN WhatsApp account, reached through the
 * Stewra Bridge app running on the USER'S OWN COMPUTER (build-plan principle 7).
 *
 * Read the absences here, because they are the design:
 *
 *   • There is NO table of WhatsApp credentials. Stewra's servers never hold a WhatsApp session, never
 *     open a socket to WhatsApp, and cannot impersonate the user if this database is stolen. The Baileys
 *     credentials live in the OS keychain on the user's machine and never cross the network.
 *
 *   • There is NO table of the user's chats. `whatsapp_chats` holds only the chats the user has
 *     explicitly ALLOWED — the row's existence IS the permission, which is why there is no `allowed`
 *     boolean to accidentally get wrong. Every other chat is filtered on the user's own machine and
 *     never reaches us at all. That is a checkable promise, not a policy we ask you to trust.
 *
 * What we do hold is the mirror image of what we already hold for Gmail: message bodies encrypted at
 * rest (`encryptField`, the same AES-256-GCM as the vault), a retention window that sweeps them, and a
 * confirm-gated outbox. Nothing new in kind — the agent has read the user's email since M2.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  // The typed acknowledgement, kept VERBATIM and VERSIONED. We store the exact words the user typed —
  // not a boolean — because the whole justification for shipping a bannable feature is that the user
  // knowingly accepted a specific, stated consequence. If we later reword the sentence, this row still
  // proves what THIS person actually agreed to. Append-only in spirit: never updated, only inserted.
  await sql`
    CREATE TABLE bridge_consents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      version integer NOT NULL,
      sentence text NOT NULL,
      consented_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`CREATE INDEX idx_bridge_consents_user_version ON bridge_consents (user_id, version)`.execute(
    db,
  );

  // One row per Stewra Bridge install. Deliberately modelled on WhatsApp's own "Linked devices" screen:
  // the user can see every device that speaks for them and kill any of them instantly, which is the
  // strongest safety property this design has.
  //
  // There is NO `revoked_at`, and that is the point: revoking a device DELETES the row. A soft-delete
  // would leave the token hash sitting in the table, and "revoked" would be a property some future query
  // has to remember to filter on — exactly the sort of thing that gets forgotten once and silently
  // resurrects a credential the user believed they had destroyed. Deletion cannot be forgotten. The
  // append-only `audit_log` keeps the record that the device existed and when it was revoked.
  //
  // `token_hash` is SHA-256, not bcrypt — correct here, and NOT a shortcut. bcrypt exists to slow down
  // guessing a low-entropy human password; a bridge token is 32 random bytes, so there is nothing to
  // guess, and we need an indexed equality lookup on every socket connect.
  await sql`
    CREATE TABLE bridge_devices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name varchar(64) NOT NULL,
      token_hash char(64) NOT NULL,
      app_version varchar(32) NOT NULL,
      wa_state varchar(16) NOT NULL DEFAULT 'disconnected',
      consent_version integer NOT NULL,
      consented_at timestamptz NOT NULL,
      last_seen_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  // The token IS the lookup key from an otherwise-unauthenticated socket connect, so it must be globally
  // unambiguous — the same reasoning as `channel_link_codes.code`.
  await sql`CREATE UNIQUE INDEX uq_bridge_devices_token ON bridge_devices (token_hash)`.execute(db);
  await sql`CREATE INDEX idx_bridge_devices_user ON bridge_devices (user_id)`.execute(db);

  // ALLOWED chats only — see the header. A chat exists here because the user ticked it, or because it is
  // their own "Message yourself" chat (the only one allowed by default, and the whole of v1).
  //
  // Scoped to the USER, not to the device that happened to forward it. A chat the user allowed is a fact
  // about the user; if they replace their laptop, their allowlist and history should survive the swap
  // rather than being collateral damage of it. (Which bridge delivers a message is a routing question,
  // answered at send time by whichever one is online.)
  //
  // The JID is a phone number, so it gets BOTH treatments: `jid_ciphertext` (recoverable, for the bridge
  // and the briefing) and `jid_hmac` (a keyed, deterministic handle for lookup and dedupe). It is an
  // HMAC and not a plain SHA-256 because a phone number carries only ~10 digits of entropy — a bare hash
  // of one is reversible by brute force in seconds, so copying `email_contacts.address_sha256`'s pattern
  // here would be protection in appearance only.
  await sql`
    CREATE TABLE whatsapp_chats (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      jid_hmac char(64) NOT NULL,
      jid_ciphertext text NOT NULL,
      display_name_ciphertext text NOT NULL DEFAULT '',
      is_self_chat boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX uq_whatsapp_chats_user_jid ON whatsapp_chats (user_id, jid_hmac)`.execute(
    db,
  );

  // Message bodies, encrypted at rest exactly as `email_messages.body_ciphertext` is. `provider_message_id`
  // is Baileys' `key.id`, which is unique PER CHAT rather than globally — hence the composite unique
  // index, and hence why the cross-channel dedupe key in `channel_inbound_messages` is derived from the
  // chat's HMAC rather than from the id alone.
  await sql`
    CREATE TABLE whatsapp_messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      chat_id uuid NOT NULL REFERENCES whatsapp_chats(id) ON DELETE CASCADE,
      provider_message_id varchar(255) NOT NULL,
      direction varchar(8) NOT NULL,
      from_me boolean NOT NULL DEFAULT false,
      body_ciphertext text NOT NULL DEFAULT '',
      sent_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX uq_whatsapp_messages_chat_provider
      ON whatsapp_messages (chat_id, provider_message_id)
  `.execute(db);
  // The retention sweep and any "what came in today" read both scan by user over time.
  await sql`CREATE INDEX idx_whatsapp_messages_user_sent ON whatsapp_messages (user_id, sent_at)`.execute(
    db,
  );

  // The outbox. Postgres is the queue because the bridge may simply be OFF — the user's laptop is shut.
  // We enqueue first and deliver when a device says hello, so a closed lid costs latency and never
  // correctness. A row here is only ever created by the deterministic confirm endpoint after the user
  // approved the send; the agent proposes and has no path to this table.
  //
  // `device_id` is NULLABLE and ON DELETE SET NULL: it records which bridge actually DELIVERED the
  // message, so it is unknown while the message is still pending, and revoking a device must not silently
  // destroy a send the user already approved — it just goes back to waiting for whichever bridge is next
  // to come online.
  await sql`
    CREATE TABLE whatsapp_outbound (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      chat_id uuid NOT NULL REFERENCES whatsapp_chats(id) ON DELETE CASCADE,
      device_id uuid REFERENCES bridge_devices(id) ON DELETE SET NULL,
      body_ciphertext text NOT NULL,
      status varchar(16) NOT NULL DEFAULT 'pending',
      attempts integer NOT NULL DEFAULT 0,
      provider_message_id varchar(255),
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      sent_at timestamptz
    )
  `.execute(db);
  // The drain query when a bridge comes online: everything still pending for that bridge's user.
  await sql`CREATE INDEX idx_whatsapp_outbound_user_status ON whatsapp_outbound (user_id, status)`.execute(
    db,
  );
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('whatsapp_outbound').execute();
  await db.schema.dropTable('whatsapp_messages').execute();
  await db.schema.dropTable('whatsapp_chats').execute();
  await db.schema.dropTable('bridge_devices').execute();
  await db.schema.dropTable('bridge_consents').execute();
}
