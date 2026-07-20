import { pathToFileURL } from 'node:url';
import type { Kysely} from 'kysely';
import { sql } from 'kysely';
import { db, closeDb } from './index.js';
import type { Database } from './types.js';
import * as m001 from './migrations/001_users.js';
import * as m002 from './migrations/002_audit_log.js';
import * as m003 from './migrations/003_connections.js';
import * as m004 from './migrations/004_vault_secrets.js';
import * as m005 from './migrations/005_user_preferences.js';
import * as m006 from './migrations/006_email_verification.js';
import * as m007 from './migrations/007_agent_insights.js';
import * as m008 from './migrations/008_insight_feedback.js';
import * as m009 from './migrations/009_agent_memory.js';
import * as m010 from './migrations/010_process_memory.js';
import * as m011 from './migrations/011_sent_mail_optin.js';
import * as m012 from './migrations/012_insight_engagement.js';
import * as m013 from './migrations/013_process_memory_reward_double.js';
import * as m014 from './migrations/014_contacts.js';
import * as m015 from './migrations/015_conversations.js';
import * as m016 from './migrations/016_messages.js';
import * as m017 from './migrations/017_message_reactions_read_receipts.js';
import * as m018 from './migrations/018_call_sessions.js';
import * as m019 from './migrations/019_call_push_tokens.js';
import * as m020 from './migrations/020_stewra_ai_conversation.js';
import * as m021 from './migrations/021_media_assets.js';
import * as m022 from './migrations/022_password_reset_codes.js';
import * as m023 from './migrations/023_connection_scopes.js';
import * as m024 from './migrations/024_email_store.js';
import * as m025 from './migrations/025_email_retention_pref.js';
import * as m026 from './migrations/026_briefings_suggestions.js';
import * as m027 from './migrations/027_chat_receipts_avatars_prefs.js';
import * as m028 from './migrations/028_channel_identities.js';
import * as m029 from './migrations/029_whatsapp_bridge.js';
import * as m030 from './migrations/030_email_over_whatsapp_optin.js';
import * as m031 from './migrations/031_push_tokens.js';
import * as m032 from './migrations/032_push_tokens_add_fcm_token.js';
import * as m033 from './migrations/033_runner_devices.js';
import * as m034 from './migrations/034_runner_sessions.js';
import { logger } from '../utils/logger.js';

interface Migration {
  readonly name: string;
  readonly up: (db: Kysely<Database>) => Promise<void>;
}

/** Ordered migration list. Append new migrations here. */
const MIGRATIONS: ReadonlyArray<Migration> = [
  { name: '001_users', up: m001.up },
  { name: '002_audit_log', up: m002.up },
  { name: '003_connections', up: m003.up },
  { name: '004_vault_secrets', up: m004.up },
  { name: '005_user_preferences', up: m005.up },
  { name: '006_email_verification', up: m006.up },
  { name: '007_agent_insights', up: m007.up },
  { name: '008_insight_feedback', up: m008.up },
  { name: '009_agent_memory', up: m009.up },
  { name: '010_process_memory', up: m010.up },
  { name: '011_sent_mail_optin', up: m011.up },
  { name: '012_insight_engagement', up: m012.up },
  { name: '013_process_memory_reward_double', up: m013.up },
  { name: '014_contacts', up: m014.up },
  { name: '015_conversations', up: m015.up },
  { name: '016_messages', up: m016.up },
  { name: '017_message_reactions_read_receipts', up: m017.up },
  { name: '018_call_sessions', up: m018.up },
  { name: '019_call_push_tokens', up: m019.up },
  { name: '020_stewra_ai_conversation', up: m020.up },
  { name: '021_media_assets', up: m021.up },
  { name: '022_password_reset_codes', up: m022.up },
  { name: '023_connection_scopes', up: m023.up },
  { name: '024_email_store', up: m024.up },
  { name: '025_email_retention_pref', up: m025.up },
  { name: '026_briefings_suggestions', up: m026.up },
  { name: '027_chat_receipts_avatars_prefs', up: m027.up },
  { name: '028_channel_identities', up: m028.up },
  { name: '029_whatsapp_bridge', up: m029.up },
  { name: '030_email_over_whatsapp_optin', up: m030.up },
  { name: '031_push_tokens', up: m031.up },
  { name: '032_push_tokens_add_fcm_token', up: m032.up },
  { name: '033_runner_devices', up: m033.up },
  { name: '034_runner_sessions', up: m034.up },
];

async function ensureMigrationsTable(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS migrations (
      name varchar(255) PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `.execute(db);
}

async function appliedNames(): Promise<ReadonlySet<string>> {
  const rows = await db.selectFrom('migrations').select('name').execute();
  return new Set(rows.map((r) => r.name));
}

export async function migrate(): Promise<void> {
  await ensureMigrationsTable();
  const applied = await appliedNames();

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) {
      logger.info(`migration already applied: ${migration.name}`);
      continue;
    }
    logger.info(`applying migration: ${migration.name}`);
    // Each migration runs in its own transaction; a failure aborts the whole run (fail-fast).
    await db.transaction().execute(async (trx) => {
      await migration.up(trx);
      await trx.insertInto('migrations').values({ name: migration.name }).execute();
    });
    logger.info(`applied migration: ${migration.name}`);
  }
}

// Run directly: `tsx src/database/migrate.ts` (or `node dist/database/migrate.js`). Under ESM there is
// no `require.main`; the entry module is the one whose URL matches the invoked argv path.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  migrate()
    .then(async () => {
      logger.info('migrations complete');
      await closeDb();
      process.exit(0);
    })
    .catch(async (err: unknown) => {
      logger.error('migration failed', { error: err instanceof Error ? err.message : String(err) });
      await closeDb();
      process.exit(1);
    });
}
