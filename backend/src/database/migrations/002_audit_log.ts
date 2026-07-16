import type { Kysely} from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('audit_log')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('user_id', 'uuid', (col) => col.references('users.id').onDelete('set null'))
    .addColumn('action', 'varchar(64)', (col) => col.notNull())
    .addColumn('resource_type', 'varchar(32)', (col) => col.notNull())
    .addColumn('resource_id', 'varchar(255)')
    .addColumn('summary', 'text', (col) => col.notNull())
    .addColumn('success', 'boolean', (col) => col.notNull())
    .addColumn('metadata', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex('idx_audit_log_user_created')
    .on('audit_log')
    .columns(['user_id', 'created_at'])
    .execute();

  // Append-only enforcement: reject any UPDATE or DELETE at the database level. This makes the
  // audit log tamper-evident regardless of application code. In production, additionally
  // `REVOKE UPDATE, DELETE ON audit_log FROM <app_role>`.
  await sql`
    CREATE OR REPLACE FUNCTION stewra_audit_log_append_only()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP;
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);

  await sql`
    CREATE TRIGGER trg_audit_log_append_only
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION stewra_audit_log_append_only();
  `.execute(db);
}

export async function down(db: Kysely<Database>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS trg_audit_log_append_only ON audit_log;`.execute(db);
  await sql`DROP FUNCTION IF EXISTS stewra_audit_log_append_only();`.execute(db);
  await db.schema.dropTable('audit_log').execute();
}
