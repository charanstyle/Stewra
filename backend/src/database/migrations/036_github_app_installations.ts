import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * The Stewra GitHub App installation — how a user grants the HOSTED runner access to chosen
 * repositories without pasting a credential.
 *
 * This table is the ONLY GitHub state at rest, and it contains no credential: just which installation
 * belongs to which user (plus the account login, for display). Git access is via installation tokens
 * minted on demand from the App's private key — short-lived (≤1 h), cached in memory only, never
 * stored. That is the hosted-mode credential invariant: no long-lived user git credential at rest on
 * Stewra. (The laptop runner keeps the stronger invariant — its machine's own git credentials, which
 * Stewra never sees at all.)
 */
export async function up(db: Kysely<Database>): Promise<void> {
  // One installation per user (MVP): the hosted runner's workspaces ARE this installation's repos, and
  // one hosted runner exists per user, so a second installation would have nothing to attach to.
  // `installation_id` is also unique globally — GitHub redirects carry only the id, so two users
  // claiming the same installation must be impossible, not just unlikely.
  await sql`
    CREATE TABLE github_app_installations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      installation_id bigint NOT NULL,
      account_login varchar(255) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`CREATE UNIQUE INDEX uq_gh_install_user ON github_app_installations (user_id)`.execute(db);
  await sql`CREATE UNIQUE INDEX uq_gh_install_installation ON github_app_installations (installation_id)`.execute(
    db,
  );
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('github_app_installations').execute();
}
