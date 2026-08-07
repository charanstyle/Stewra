import type { Selectable } from 'kysely';
import type {
  CommercePlatform,
  ContactImport,
  ContactImportRow,
  ContactImportSkipReason,
  ContactImportStatus,
} from '@stewra/shared-types';
import { db } from '../../database/index.js';
import type {
  CommerceContactImportRowsTable,
  CommerceContactImportsTable,
} from '../../database/types.js';

/**
 * Every column except the file. Named explicitly because `selectAll` here would drag the whole
 * uploaded CSV through every status poll — a megabyte a second while an import runs, to render a
 * progress number.
 */
const IMPORT_COLUMNS = [
  'id',
  'org_id',
  'created_by_user_id',
  'filename',
  'platform',
  'status',
  'total_rows',
  'imported_count',
  'skipped_count',
  'error',
  'created_at',
  'updated_at',
  'finished_at',
] as const;

type ImportRowRecord = Selectable<CommerceContactImportRowsTable>;
type ImportRecord = Omit<Selectable<CommerceContactImportsTable>, 'source_csv'>;

function toImport(row: ImportRecord): ContactImport {
  return {
    id: row.id,
    orgId: row.org_id,
    createdByUserId: row.created_by_user_id,
    filename: row.filename,
    platform: row.platform,
    status: row.status,
    totalRows: row.total_rows,
    importedCount: row.imported_count,
    skippedCount: row.skipped_count,
    error: row.error,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    finishedAt: row.finished_at === null ? null : row.finished_at.toISOString(),
  };
}

function toImportRow(row: ImportRowRecord): ContactImportRow {
  return {
    id: row.id,
    importId: row.import_id,
    rowNumber: row.row_number,
    rawPhone: row.raw_phone,
    contactId: row.contact_id,
    imported: row.imported,
    skipReason: row.skip_reason,
    detail: row.detail,
  };
}

/**
 * Uploaded lists and their per-row ledger (migration 048).
 *
 * Every read is org-scoped except the handler's, which is reached only through a job that already
 * carries the org it belongs to — the same arrangement `jobRepository` documents, for the same
 * reason.
 */
class ContactImportRepository {
  async create(params: {
    orgId: string;
    createdByUserId: string;
    filename: string;
    platform: CommercePlatform;
    sourceCsv: string;
    totalRows: number;
  }): Promise<ContactImport> {
    const row = await db
      .insertInto('commerce_contact_imports')
      .values({
        org_id: params.orgId,
        created_by_user_id: params.createdByUserId,
        filename: params.filename,
        platform: params.platform,
        source_csv: params.sourceCsv,
        total_rows: params.totalRows,
      })
      .returning(IMPORT_COLUMNS)
      .executeTakeFirstOrThrow();
    return toImport(row);
  }

  async findById(orgId: string, importId: string): Promise<ContactImport | null> {
    const row = await db
      .selectFrom('commerce_contact_imports')
      .select(IMPORT_COLUMNS)
      .where('org_id', '=', orgId)
      .where('id', '=', importId)
      .executeTakeFirst();
    return row === undefined ? null : toImport(row);
  }

  async listForOrg(orgId: string, limit: number): Promise<ContactImport[]> {
    const rows = await db
      .selectFrom('commerce_contact_imports')
      .select(IMPORT_COLUMNS)
      .where('org_id', '=', orgId)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .execute();
    return rows.map(toImport);
  }

  /** The file, read once by the handler. Separate from {@link findById} so nothing else can ask. */
  async findSource(importId: string): Promise<{ sourceCsv: string; import: ContactImport } | null> {
    const row = await db
      .selectFrom('commerce_contact_imports')
      .select([...IMPORT_COLUMNS, 'source_csv'])
      .where('id', '=', importId)
      .executeTakeFirst();
    if (row === undefined) return null;
    const { source_csv: sourceCsv, ...rest } = row;
    return { sourceCsv, import: toImport(rest) };
  }

  async markRunning(importId: string): Promise<void> {
    await db
      .updateTable('commerce_contact_imports')
      .set({ status: 'running', updated_at: new Date() })
      .where('id', '=', importId)
      .execute();
  }

  async finish(params: {
    importId: string;
    status: Extract<ContactImportStatus, 'done' | 'failed'>;
    error: string | null;
  }): Promise<void> {
    await db
      .updateTable('commerce_contact_imports')
      .set({
        status: params.status,
        error: params.error,
        updated_at: new Date(),
        finished_at: new Date(),
      })
      .where('id', '=', params.importId)
      .execute();
  }

  /**
   * Write what became of one row. Returns false when that row already had an outcome.
   *
   * The conflict is not an error and not a retry — it is a re-claimed job meeting its own earlier
   * work, which is exactly what `(import_id, row_number)` is unique for. False rather than a throw so
   * the handler's loop reads as "already done, move on".
   */
  async recordRow(params: {
    importId: string;
    rowNumber: number;
    rawPhone: string;
    contactId: string | null;
    imported: boolean;
    skipReason: ContactImportSkipReason | null;
    detail: string | null;
  }): Promise<boolean> {
    const inserted = await db
      .insertInto('commerce_contact_import_rows')
      .values({
        import_id: params.importId,
        row_number: params.rowNumber,
        raw_phone: params.rawPhone,
        contact_id: params.contactId,
        imported: params.imported,
        skip_reason: params.skipReason,
        detail: params.detail,
      })
      .onConflict((oc) => oc.columns(['import_id', 'row_number']).doNothing())
      .returning('id')
      .executeTakeFirst();
    return inserted !== undefined;
  }

  /** Which rows already have an outcome, so a resumed run skips them without re-deciding anything. */
  async processedRowNumbers(importId: string): Promise<Set<number>> {
    const rows = await db
      .selectFrom('commerce_contact_import_rows')
      .select('row_number')
      .where('import_id', '=', importId)
      .execute();
    return new Set(rows.map((row) => row.row_number));
  }

  /**
   * Recount from the ledger and store the totals on the import.
   *
   * Recomputed rather than incremented, because a job that is claimed twice would double an
   * increment while the ledger it was counting stayed right. The counters are a cache of this query;
   * the rows are the truth.
   */
  async refreshCounts(importId: string): Promise<{ imported: number; skipped: number }> {
    const rows = await db
      .selectFrom('commerce_contact_import_rows')
      .select('imported')
      .where('import_id', '=', importId)
      .execute();
    const imported = rows.filter((row) => row.imported).length;
    const skipped = rows.length - imported;
    await db
      .updateTable('commerce_contact_imports')
      .set({ imported_count: imported, skipped_count: skipped, updated_at: new Date() })
      .where('id', '=', importId)
      .execute();
    return { imported, skipped };
  }

  /** The skipped rows, in file order — the report. Capped by the caller. */
  async listSkippedRows(importId: string, limit: number): Promise<ContactImportRow[]> {
    const rows = await db
      .selectFrom('commerce_contact_import_rows')
      .selectAll()
      .where('import_id', '=', importId)
      .where('imported', '=', false)
      .orderBy('row_number', 'asc')
      .limit(limit)
      .execute();
    return rows.map(toImportRow);
  }
}

export const contactImportRepository = new ContactImportRepository();
