import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * The Stewra RUNNER — a process on the user's OWN machine (a laptop, or a cloud VM they own) that hosts
 * coding agents (Claude Code, Codex, Gemini CLI) and runs them against the user's repositories. The
 * server's role is to authenticate a runner, route sessions to a chosen machine, and observe them; the
 * code executes on the user's box, under their logins, on their files. Stewra holds no repo and no
 * provider key.
 *
 * This is the sibling of the `whatsapp_personal` bridge (migration 029) and borrows its trust model
 * deliberately — device tokens hashed at rest, revocation by row-deletion, a single-use pairing code — but
 * it is a SEPARATE surface (a runner executes code; a bridge relays WhatsApp), so it gets its own tables
 * rather than overloading the messaging-channel ones.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  // One row per Stewra Runner install, modelled on WhatsApp's "Linked devices" screen: the user can see
  // every machine that can run code for them and kill any of them instantly. That visibility + instant
  // revocation is the strongest safety property this design has.
  //
  // There is NO `revoked_at`: revoking DELETES the row, so a revoked token cannot linger behind a filter
  // some future query forgets to apply (same reasoning as `bridge_devices`). The append-only `audit_log`
  // keeps the record that the device existed and was revoked.
  //
  // `token_hash` is SHA-256, not bcrypt: a runner token is 32 random bytes (nothing to slow-guess), and we
  // need an indexed equality lookup on every socket connect.
  //
  // `harnesses` and `workspaces` are the runner's last-reported capabilities (`runner:hello`), stored as
  // jsonb so the "Runners" panel can render what each machine can do without the runner being online at
  // that instant. They are advisory, refreshed on every hello; the runner remains the source of truth.
  await sql`
    CREATE TABLE runner_devices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name varchar(64) NOT NULL,
      token_hash char(64) NOT NULL,
      app_version varchar(32) NOT NULL,
      os varchar(32) NOT NULL DEFAULT '',
      harnesses jsonb NOT NULL DEFAULT '[]'::jsonb,
      workspaces jsonb NOT NULL DEFAULT '[]'::jsonb,
      last_seen_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  // The token IS the lookup key from an otherwise-unauthenticated socket connect, so it must be globally
  // unambiguous — the same reasoning as `bridge_devices.token_hash`.
  await sql`CREATE UNIQUE INDEX uq_runner_devices_token ON runner_devices (token_hash)`.execute(db);
  await sql`CREATE INDEX idx_runner_devices_user ON runner_devices (user_id)`.execute(db);

  // Single-use pairing codes. A dedicated table rather than reusing `channel_link_codes`, whose `channel`
  // column is a MessagingChannel — a runner is not a messaging channel, and overloading that concept to
  // save one table would be a category error that every later reader has to untangle.
  //
  // Only mintable by an authenticated account owner (see runnerService.startPairing); the runner, holding
  // no user session, redeems the code for a device token. The redemption UPDATE's WHERE clause is the
  // atomic guard: two runners racing on the same code cannot both win.
  await sql`
    CREATE TABLE runner_pair_codes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code varchar(32) NOT NULL,
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX uq_runner_pair_codes_code ON runner_pair_codes (code)`.execute(db);
  await sql`CREATE INDEX idx_runner_pair_codes_user ON runner_pair_codes (user_id)`.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('runner_pair_codes').execute();
  await db.schema.dropTable('runner_devices').execute();
}
