import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * Where a chat-started runner session reports back to — on disk, not in a Map.
 *
 * When a person starts a session by texting Stewra (in the app, or on WhatsApp), the permission gate
 * the agent later hits and the final result are relayed back to THAT conversation. Until now the
 * relay target, and the permission a plain "yes" resolves against, lived only in process memory. A
 * backend deploy or restart mid-session therefore lost the WhatsApp target silently: the gate never
 * reached the phone and the session sat blocked — for a person driving sessions from WhatsApp away
 * from the desk, the exact moment it matters most.
 *
 * Two small tables, both keyed by the session and cascading with it. `runner_chat_origins` is written
 * once at start and deleted when the session ends; `runner_chat_pending_permissions` holds at most one
 * row per session — the gate it is currently blocked on — and is cleared when answered or ended.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await sql`
    CREATE TABLE runner_chat_origins (
      session_id uuid PRIMARY KEY REFERENCES runner_sessions(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      channel varchar(16) NOT NULL CHECK (channel IN ('stewra_chat', 'whatsapp')),
      device_name varchar(128) NOT NULL,
      workspace_name varchar(128) NOT NULL,
      project_name varchar(120),
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE TABLE runner_chat_pending_permissions (
      session_id uuid PRIMARY KEY REFERENCES runner_sessions(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      prompt_id varchar(128) NOT NULL,
      allow_option_id varchar(256),
      deny_option_id varchar(256),
      title text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  // "The latest permission this person is blocked on" is the one lookup the chat layer makes.
  await sql`CREATE INDEX idx_runner_chat_pending_user ON runner_chat_pending_permissions (user_id, created_at DESC)`.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`DROP TABLE IF EXISTS runner_chat_pending_permissions`.execute(db);
  await sql`DROP TABLE IF EXISTS runner_chat_origins`.execute(db);
}
