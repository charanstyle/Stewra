import { z } from 'zod';
import type { CommerceJob } from '@stewra/shared-types';
import type { JobHandler, JobOutcome } from './types.js';
import { contactImportRepository } from '../repositories/contactImportRepository.js';
import { jobRepository } from '../repositories/jobRepository.js';
import { audienceService } from '../services/audienceService.js';
import { parseContactCsv } from '../services/csvContacts.js';
import { logger } from '../../utils/logger.js';
import { ConflictError } from '../../utils/errors.js';

const payloadSchema = z.object({
  importId: z.string().uuid(),
});

/**
 * How many rows one claim of this job works through before handing the rest to a fresh job.
 *
 * Bounded for the same reason `broadcastSendHandler` sends in batches: a worker's lease expires, and
 * a claim that outlives its lease is a second worker running the same import alongside the first.
 * The ledger makes that harmless rather than corrupting, but harmless-and-duplicated is still twice
 * the database work and a confusing thing to read in the logs. Small chunks keep every claim well
 * inside a lease.
 */
const BATCH_SIZE = 200;

/**
 * Walk an uploaded list and turn its rows into contacts.
 *
 * **Idempotent by ledger.** Every row's outcome is written to `commerce_contact_import_rows`, which
 * is unique on `(import_id, row_number)`, and a resumed run skips every row that already has one. So
 * a worker killed at row 4,000 of 10,000 resumes at 4,001 rather than starting over — and starting
 * over would not double any contact either, because `already_a_contact` is a skip, not an overwrite.
 *
 * **Every row goes through `audienceService.createContact`.** Not a bulk insert, and not this file's
 * own copy of the rules. The consent regime is only worth anything if it cannot be bypassed by
 * whichever door was used, and an importer with its own write path is precisely how a bulk list ends
 * up in a database that a hand-typed contact could never have entered. The cost is one round trip
 * per row; the alternative is two definitions of who may be messaged.
 */
class ContactImportHandler implements JobHandler {
  readonly kind = 'contact_import' as const;

  async handle(job: CommerceJob): Promise<JobOutcome> {
    const parsed = payloadSchema.safeParse(job.payload);
    if (!parsed.success) {
      return {
        kind: 'failed',
        reason: `payload is not a contact_import payload: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      };
    }
    const importId = parsed.data.importId;

    const found = await contactImportRepository.findSource(importId);
    if (found === null) return { kind: 'failed', reason: 'the import no longer exists' };

    // The job carries its own org and so does the import. They can only disagree if something
    // enqueued across tenants, and an import that ran anyway would write one client's list into
    // another's audience — the single worst outcome this plane has.
    if (found.import.orgId !== job.orgId) {
      return { kind: 'failed', reason: 'the import belongs to a different organization' };
    }

    // A terminal import meeting a duplicate job. Nothing to do, and nothing wrong.
    if (found.import.status === 'done' || found.import.status === 'failed') {
      return { kind: 'done' };
    }

    const recordedByUserId = found.import.createdByUserId;
    if (recordedByUserId === null) {
      const reason =
        'the person who uploaded this file no longer has an account, so the consent it records ' +
        'could not be attributed to anyone';
      await contactImportRepository.finish({ importId, status: 'failed', error: reason });
      return { kind: 'failed', reason };
    }

    // Re-parsed on every claim rather than carried in the payload. The file is the stored artifact
    // and the reader is the code; keeping the rows only in memory between claims would mean a
    // restart lost them, and keeping them in the job payload would mean a parser fix never reached
    // an import that was already queued.
    const rows = parseContactCsv(found.sourceCsv);
    if (!rows.ok) {
      // Only reachable if the file passed `contactImportService.create` and this build reads it
      // differently — a parser change between the upload and the run. The import fails whole rather
      // than importing the part this build happens to still understand.
      await contactImportRepository.finish({ importId, status: 'failed', error: rows.reason });
      return { kind: 'failed', reason: rows.reason };
    }

    if (found.import.status === 'queued') await contactImportRepository.markRunning(importId);

    const processed = await contactImportRepository.processedRowNumbers(importId);
    const pending = rows.rows.filter((row) => !processed.has(row.rowNumber));
    const batch = pending.slice(0, BATCH_SIZE);

    for (const row of batch) {
      if (!row.ok) {
        await contactImportRepository.recordRow({
          importId,
          rowNumber: row.rowNumber,
          rawPhone: row.rawPhone,
          contactId: null,
          imported: false,
          skipReason: row.reason,
          detail: row.detail,
        });
        continue;
      }

      try {
        const result = await audienceService.createContact({
          orgId: job.orgId,
          platform: found.import.platform,
          phone: row.phoneE164,
          displayName: row.displayName,
          attributes: row.attributes,
          tags: row.tags,
          consent: row.consent,
          recordedByUserId,
        });
        await contactImportRepository.recordRow({
          importId,
          rowNumber: row.rowNumber,
          rawPhone: row.rawPhone,
          contactId: result.contact.contact.id,
          imported: true,
          skipReason: null,
          detail: null,
        });
      } catch (error) {
        if (error instanceof ConflictError) {
          // This person is already in the audience. Skipped rather than updated, deliberately: an
          // import that overwrote existing contacts would let a stale export silently replace a name
          // an operator corrected by hand, and re-assert consent on someone whose state has since
          // moved on. The row is reported so the operator can decide what they actually meant.
          await contactImportRepository.recordRow({
            importId,
            rowNumber: row.rowNumber,
            rawPhone: row.rawPhone,
            contactId: null,
            imported: false,
            skipReason: 'already_a_contact',
            detail: error.message,
          });
          continue;
        }
        // Anything else is ours, not theirs. A ValidationError here means this file passed the reader
        // and was then refused by the writer, which is a disagreement between two pieces of our own
        // code — recording it as a skipped row would blame the operator's file for our bug. It goes
        // up, becomes a retry, and eventually a dead job someone has to look at.
        throw error;
      }
    }

    const counts = await contactImportRepository.refreshCounts(importId);

    if (pending.length > batch.length) {
      await jobRepository.enqueue({ orgId: job.orgId, kind: 'contact_import', payload: { importId } });
      return { kind: 'done' };
    }

    await contactImportRepository.finish({ importId, status: 'done', error: null });
    logger.info('commerce: contact import finished', {
      orgId: job.orgId,
      importId,
      imported: counts.imported,
      skipped: counts.skipped,
    });
    return { kind: 'done' };
  }
}

export const contactImportHandler = new ContactImportHandler();
