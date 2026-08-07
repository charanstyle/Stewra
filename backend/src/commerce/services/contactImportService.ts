import type { CommercePlatform, ContactImport, ContactImportRow } from '@stewra/shared-types';
import { config } from '../../config/unifiedConfig.js';
import { contactImportRepository } from '../repositories/contactImportRepository.js';
import { jobRepository } from '../repositories/jobRepository.js';
import { parseContactCsv } from './csvContacts.js';
import { NotFoundError, ServiceUnavailableError, ValidationError } from '../../utils/errors.js';

/**
 * How many skipped rows one report carries.
 *
 * Capped because the report is read in a browser and a fifty-thousand-row file can skip all fifty
 * thousand. The response says when it was cut, so a client never shows a truncated list as the whole
 * of it — the counts on the import itself remain exact either way.
 */
const SKIPPED_ROWS_LIMIT = 200;

/**
 * Uploading a contact list, and reading back what happened to it.
 *
 * The whole file is parsed at the door, before anything is stored. That is deliberate: a header with
 * no `consent_source` column, a duplicated column, an attribute name no segment could ever
 * reference — these are facts about the file, and learning them as a 400 while the operator is still
 * looking at the upload box costs them a minute. Learning them twenty minutes later, as an import
 * that failed, costs them the afternoon they spent believing their list was in.
 *
 * What is NOT decided here is any individual row's fate. Row work belongs to the job, because it
 * touches the database once per row and a fifty-thousand-row request that holds a connection open is
 * not a request.
 */
class ContactImportService {
  /**
   * Refuse to queue an import nothing will drain.
   *
   * The same argument `broadcastService.assertDispatchable` makes, and it applies here for a reason
   * that has nothing to do with Meta: `startCommerceScheduler` returns before `commerceWorker.start()`
   * when the integration is off, so with the flag down this would write an import, answer 202, and
   * leave the file sitting in `commerce_jobs` forever while the operator watched a progress bar that
   * would never move. An import needs no Meta credential to run — but it does need the worker that
   * only starts alongside one, and telling a client their list is importing when it is not is the
   * failure this refusal exists to prevent.
   */
  private assertDrainable(): void {
    if (!config.metaCommerce.enabled) {
      throw new ServiceUnavailableError(
        'Contact imports are not enabled on this install, so an upload now would never be ' +
          'processed. Set META_COMMERCE_ENABLED=true and bring up the commerce worker first.',
      );
    }
  }

  /**
   * Accept a file: validate it whole, store it, and queue the work.
   *
   * The uploaded bytes are stored verbatim rather than the parsed rows. What an organization
   * asserted about a hundred people's consent is a claim someone may have to defend, and the
   * defensible artifact is the file they uploaded — not our reading of it.
   */
  async create(params: {
    orgId: string;
    createdByUserId: string;
    filename: string;
    platform: CommercePlatform;
    csv: string;
  }): Promise<ContactImport> {
    this.assertDrainable();

    const parsed = parseContactCsv(params.csv);
    if (!parsed.ok) {
      throw new ValidationError('Validation failed', [{ field: 'file', message: parsed.reason }]);
    }

    const created = await contactImportRepository.create({
      orgId: params.orgId,
      createdByUserId: params.createdByUserId,
      filename: params.filename,
      platform: params.platform,
      sourceCsv: params.csv,
      totalRows: parsed.rows.length,
    });

    // No dedupe key. The same list uploaded twice is a thing operators do on purpose — after fixing
    // the rows that were skipped — and the second run's rows land as `already_a_contact` rather than
    // as duplicates, so there is nothing here for idempotency to protect.
    await jobRepository.enqueue({
      orgId: params.orgId,
      kind: 'contact_import',
      payload: { importId: created.id },
    });

    return created;
  }

  async list(orgId: string, limit: number): Promise<ContactImport[]> {
    return contactImportRepository.listForOrg(orgId, limit);
  }

  /** The import, plus the rows that did not go in — the only ones that still need reading. */
  async get(
    orgId: string,
    importId: string,
  ): Promise<{
    import: ContactImport;
    skippedRows: ContactImportRow[];
    skippedTruncated: boolean;
  }> {
    const found = await contactImportRepository.findById(orgId, importId);
    if (found === null) throw new NotFoundError('Import not found');

    // One more than the cap, so "was this cut" is answered by the query rather than by comparing
    // against a count that may have moved while the import is still running.
    const rows = await contactImportRepository.listSkippedRows(importId, SKIPPED_ROWS_LIMIT + 1);
    return {
      import: found,
      skippedRows: rows.slice(0, SKIPPED_ROWS_LIMIT),
      skippedTruncated: rows.length > SKIPPED_ROWS_LIMIT,
    };
  }
}

export const contactImportService = new ContactImportService();
