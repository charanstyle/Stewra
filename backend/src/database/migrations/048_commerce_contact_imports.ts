import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * Uploaded contact lists, and what became of every row in them.
 *
 * Two tables because an import is two different questions. `commerce_contact_imports` answers "did my
 * file go through", which is what the operator watches while it runs. `commerce_contact_import_rows`
 * answers "which of my five hundred rows did not, and why" — the question that arrives afterwards,
 * usually alongside "and can I fix them and try again".
 *
 * **The file is stored on the import row.** `source_csv` holds exactly the bytes that were uploaded,
 * as text. Two reasons, and neither is convenience: a job queue with the payload somewhere else is a
 * job that can be claimed after the somewhere-else is gone, and this is a record of the assertion an
 * organization made about a hundred people's consent — the evidence for which is the file they
 * uploaded, not our summary of it. It is capped at the edge (multer's `fileSize`) so a row here can
 * never be larger than an upload was allowed to be, and Postgres TOASTs it out of the main heap, so
 * the status polls that read this table every few seconds do not drag a megabyte along with them.
 *
 * Nothing is deleted when an import finishes. A skipped-row ledger that is tidied away leaves the
 * client with a contact list that is smaller than their file and no remaining explanation of why.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('commerce_contact_imports')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('org_id', 'uuid', (col) =>
      col.notNull().references('organizations.id').onDelete('cascade'),
    )
    // Who uploaded it — and therefore who the consent rows this import writes are attributed to.
    // Nullable with `set null` to match every other actor column in this plane, so erasing a user is
    // not blocked by a file they uploaded. The handler refuses to run an import whose uploader has
    // gone rather than writing consent evidence signed by nobody.
    .addColumn('created_by_user_id', 'uuid', (col) => col.references('users.id').onDelete('set null'))
    // Shown back to the operator so they can tell two uploads apart. Never opened, never joined to a
    // path — it is a label the browser supplied and is trusted exactly that far.
    .addColumn('filename', 'varchar(255)', (col) => col.notNull())
    .addColumn('platform', 'varchar(32)', (col) => col.notNull())
    .addColumn('status', 'varchar(16)', (col) =>
      col
        .notNull()
        .defaultTo('queued')
        .check(sql`status in ('queued', 'running', 'done', 'failed')`),
    )
    // The uploaded bytes. See the note above — this is the evidence, not a cache of it.
    .addColumn('source_csv', 'text', (col) => col.notNull())
    // Counted when the file is accepted, so "412 of 900" is answerable from the first poll rather
    // than only once the run is over.
    .addColumn('total_rows', 'integer', (col) => col.notNull())
    .addColumn('imported_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('skipped_count', 'integer', (col) => col.notNull().defaultTo(0))
    // Why the import as a whole did not happen. A `done` import with skipped rows leaves this null
    // and explains itself per row — those rows are its findings, not its failure.
    .addColumn('error', 'text')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('finished_at', 'timestamptz')
    .execute();

  // "My imports, newest first" — the only listing this table has.
  await db.schema
    .createIndex('idx_commerce_contact_imports_org')
    .on('commerce_contact_imports')
    .columns(['org_id', 'created_at'])
    .execute();

  await db.schema
    .createTable('commerce_contact_import_rows')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('import_id', 'uuid', (col) =>
      col.notNull().references('commerce_contact_imports.id').onDelete('cascade'),
    )
    // 1-based over data rows, excluding the header, because that is the number the operator can find
    // in their own spreadsheet. Off by one here would send someone to the wrong line of a 900-row file.
    .addColumn('row_number', 'integer', (col) => col.notNull())
    // The phone as the file wrote it, before any normalization. A row skipped for an unparseable
    // number cannot be located by the normalized form — there isn't one.
    .addColumn('raw_phone', 'varchar(64)', (col) => col.notNull())
    .addColumn('contact_id', 'uuid', (col) =>
      col.references('commerce_contacts.id').onDelete('set null'),
    )
    .addColumn('imported', 'boolean', (col) => col.notNull())
    .addColumn('skip_reason', 'varchar(32)')
    .addColumn('detail', 'text')
    // An imported row has no reason and a skipped row must have one. Without this the ledger can hold
    // a row that says only "not imported", which is the one thing the client already knows.
    .addCheckConstraint(
      'commerce_contact_import_rows_reason_ck',
      sql`(imported and skip_reason is null) or (not imported and skip_reason is not null)`,
    )
    .execute();

  // Both the report's ordering and the handler's idempotency. A job whose lease expired half way is
  // claimed again by another worker; it resumes by reading the highest row number already written
  // here, and this index is what makes writing a row twice impossible rather than merely unlikely.
  await db.schema
    .createIndex('uq_commerce_contact_import_rows')
    .on('commerce_contact_import_rows')
    .columns(['import_id', 'row_number'])
    .unique()
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('commerce_contact_import_rows').ifExists().execute();
  await db.schema.dropTable('commerce_contact_imports').ifExists().execute();
}
