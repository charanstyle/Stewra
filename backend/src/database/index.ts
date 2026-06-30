import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { config } from '../config/unifiedConfig';
import type { Database } from './types';

const pool = new Pool({
  connectionString: config.database.url,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

export const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool }),
});

/** Fail-fast connectivity check used at startup — throws if the DB is unreachable. */
export async function assertDbConnection(): Promise<void> {
  await db.selectFrom('migrations').select('name').limit(1).execute().catch(async (err: unknown) => {
    // The migrations table may not exist yet on a fresh DB; fall back to a trivial probe.
    await pool.query('SELECT 1');
    if (!(err instanceof Error)) {
      throw new Error('Database probe failed with a non-Error value');
    }
  });
}

export async function closeDb(): Promise<void> {
  await db.destroy();
}
