import type { Kysely} from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types';

export async function up(db: Kysely<Database>): Promise<void> {
  // The vault's backing store. Holds only AES-256-GCM ciphertext envelopes, keyed by an opaque
  // handle. The connections table references rows here by id; raw tokens never live in app rows.
  await db.schema
    .createTable('vault_secrets')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('ciphertext', 'text', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('vault_secrets').execute();
}
