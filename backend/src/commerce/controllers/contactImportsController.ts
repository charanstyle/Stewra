import type { Request, Response } from 'express';
import { z } from 'zod';
import { COMMERCE_PLATFORMS } from '@stewra/shared-types';
import type {
  CreateContactImportResponse,
  GetContactImportResponse,
  ListContactImportsResponse,
} from '@stewra/shared-types';
import { BaseController } from '../../controllers/baseController.js';
import { contactImportService } from '../services/contactImportService.js';
import { orgContext } from '../middleware/requireOrgMember.js';
import { parse } from '../../utils/validate.js';
import { ValidationError } from '../../utils/errors.js';

const importParamsSchema = z.object({ importId: z.string().uuid() });

const listImportsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * The form fields riding alongside the file. `platform` only, and optional for the same reason it is
 * optional on `POST /contacts`: `whatsapp_cloud` is the only thing anything can be sent on today.
 */
const createImportSchema = z.object({
  platform: z.enum(COMMERCE_PLATFORMS).optional(),
});

/**
 * A CSV is text, and the browser will label it almost anything.
 *
 * Excel sends `application/vnd.ms-excel` for a file it saved as CSV; some browsers send
 * `application/octet-stream`; Safari has been known to send nothing useful at all. The type is
 * therefore checked loosely and the CONTENT is checked strictly — `parseContactCsv` refuses a file
 * whose header is not a header, which is the only test that actually distinguishes a contact list
 * from a spreadsheet someone grabbed by mistake.
 */
const CSV_MIME_HINTS = ['text/csv', 'text/plain', 'application/csv', 'application/vnd.ms-excel'];

function looksLikeCsv(mimetype: string, filename: string): boolean {
  if (CSV_MIME_HINTS.some((hint) => mimetype.startsWith(hint))) return true;
  if (mimetype === 'application/octet-stream') return true;
  return filename.toLowerCase().endsWith('.csv');
}

/**
 * Bulk contact ingestion.
 *
 * Reads are `viewer` and the upload is `admin`, matching the rest of the audience surface. The report
 * is a read of the organization's own contact list, which a viewer can already see; accepting a file
 * is asserting that this organization holds several hundred people's numbers with their permission,
 * which is not.
 */
class ContactImportsController extends BaseController {
  /** POST /orgs/:orgId/contacts/import — multipart, one `file` part. */
  async create(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const userId = req.userId;
      if (userId === undefined) throw new Error('requireAuth middleware missing');

      const file = req.file;
      if (file === undefined) {
        throw new ValidationError('Validation failed', [
          { field: 'file', message: 'Attach a CSV file as the `file` part of the upload.' },
        ]);
      }
      if (!looksLikeCsv(file.mimetype, file.originalname)) {
        throw new ValidationError('Validation failed', [
          {
            field: 'file',
            message: `"${file.originalname}" does not look like a CSV. Export the list as CSV first.`,
          },
        ]);
      }

      const fields = parse(createImportSchema, req.body);
      const created = await contactImportService.create({
        orgId,
        createdByUserId: userId,
        // The browser's own label, truncated to what the column holds. Never used as a path, and
        // never resolved against the filesystem — an upload names nothing on this machine.
        filename: file.originalname.slice(0, 255),
        platform: fields.platform ?? 'whatsapp_cloud',
        csv: file.buffer.toString('utf8'),
      });

      const body: CreateContactImportResponse = { import: created };
      // 202, not 201: the import exists, the contacts do not yet. A 201 would invite a client to
      // reload the contact list and find it unchanged.
      this.handleSuccess(res, body, 202);
    } catch (error) {
      this.handleError(error, res, 'ContactImportsController.create');
    }
  }

  /** GET /orgs/:orgId/contacts/imports */
  async list(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const query = parse(listImportsSchema, req.query);
      const imports = await contactImportService.list(orgId, query.limit ?? 20);
      const body: ListContactImportsResponse = { imports };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'ContactImportsController.list');
    }
  }

  /** GET /orgs/:orgId/contacts/imports/:importId */
  async get(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const { importId } = parse(importParamsSchema, req.params);
      const found = await contactImportService.get(orgId, importId);
      const body: GetContactImportResponse = {
        import: found.import,
        skippedRows: found.skippedRows,
        skippedTruncated: found.skippedTruncated,
      };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'ContactImportsController.get');
    }
  }
}

export const contactImportsController = new ContactImportsController();
