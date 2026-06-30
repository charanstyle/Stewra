import type { Kysely} from 'kysely';
import { sql } from 'kysely';
import { db, closeDb } from './index';
import type { Database } from './types';
import * as m001 from './migrations/001_users';
import * as m002 from './migrations/002_audit_log';
import * as m003 from './migrations/003_connections';
import * as m004 from './migrations/004_vault_secrets';
import * as m005 from './migrations/005_user_preferences';
import * as m006 from './migrations/006_email_verification';
import { logger } from '../utils/logger';

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

// Run directly: `tsx src/database/migrate.ts`
if (require.main === module) {
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
