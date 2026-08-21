import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import type { ApiResponse } from '@stewra/shared-types';
import { contactsController } from '../controllers/contactsController.js';
import { contactImportsController } from '../controllers/contactImportsController.js';
import { optinLinksController } from '../controllers/optinLinksController.js';
import { segmentsController } from '../controllers/segmentsController.js';
import { requireOrgMember } from '../../tenancy/middleware/requireOrgMember.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireEmailVerification } from '../../middleware/requireEmailVerification.js';

// `mergeParams` so `:orgId` from the parent mount reaches requireOrgMember.
const router = Router({ mergeParams: true });

const verified = (req: Request, res: Response, next: NextFunction): void => {
  void requireEmailVerification(req, res, next);
};

/**
 * The audience surface — contacts, tags and segments — mounted under `/orgs/:orgId`.
 *
 * Reads are `viewer`, writes are `admin`, matching the consent routes next door. The line is drawn in
 * the same place for the same reason: an agent working the inbox needs to see who a contact is and
 * which segments exist, but editing a segment silently changes who the next campaign reaches, and
 * that is a decision the organization is answerable for rather than a step in answering a message.
 *
 * `POST /segments/preview` is a read despite the verb — it computes an audience and stores nothing.
 * It is a POST only because a rule tree does not fit in a query string.
 */

// --- Contacts -------------------------------------------------------------------------------

router.get('/contacts', requireAuth, verified, requireOrgMember('viewer'), (req, res) => {
  void contactsController.list(req, res);
});

// `admin`, matching PATCH below rather than the `viewer` reads. Adding a contact is asserting that
// this organization holds a person's number, and — when the request carries consent — that they
// agreed to be messaged. That is the same class of statement as editing a segment, not a step in
// answering an inbox message.
router.post('/contacts', requireAuth, verified, requireOrgMember('admin'), (req, res) => {
  void contactsController.create(req, res);
});

// --- Bulk import ----------------------------------------------------------------------------
//
// Declared before `/contacts/:contactId` so the literal "import" and "imports" can never be read as
// a contact id — the same ordering `/segments/preview` needs, for the same reason.

/**
 * The uploaded file, in memory and size-capped.
 *
 * 8 MB is comfortably above `MAX_IMPORT_ROWS` rows of realistic width and far below anything that
 * threatens the process. The cap is enforced HERE rather than after parsing because a file this
 * route will refuse should never be read into a buffer at all, and because `source_csv` stores what
 * arrives — an unbounded upload would be an unbounded row.
 *
 * `files: 1`: one list per import. Two files in one request would be two imports sharing a single
 * ledger and a single count, which no report could then take apart.
 */
const uploadCsv = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
}).single('file');

/**
 * Multer's own failures, answered in this route's voice.
 *
 * Without this an oversized upload reaches the generic error handler as an unhandled exception and
 * becomes a 500 with an alert attached — a request that is entirely the client's to fix, reported as
 * our fault. Same argument as `318167b` and `6a2c983`: a malformed request is a 400 at the paste.
 */
const acceptCsv = (req: Request, res: Response, next: NextFunction): void => {
  uploadCsv(req, res, (error: unknown) => {
    if (error instanceof multer.MulterError) {
      const body: ApiResponse<never> = {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message:
            error.code === 'LIMIT_FILE_SIZE'
              ? 'That file is larger than 8 MB. Split the list and import it in parts.'
              : `That upload could not be read: ${error.message}`,
          details: [{ field: 'file', message: error.code }],
        },
      };
      res.status(400).json(body);
      return;
    }
    if (error !== null && error !== undefined) {
      next(error);
      return;
    }
    next();
  });
};

router.post(
  '/contacts/import',
  requireAuth,
  verified,
  requireOrgMember('admin'),
  acceptCsv,
  (req, res) => {
    void contactImportsController.create(req, res);
  },
);

router.get(
  '/contacts/imports',
  requireAuth,
  verified,
  requireOrgMember('viewer'),
  (req, res) => {
    void contactImportsController.list(req, res);
  },
);

router.get(
  '/contacts/imports/:importId',
  requireAuth,
  verified,
  requireOrgMember('viewer'),
  (req, res) => {
    void contactImportsController.get(req, res);
  },
);

router.get('/contacts/:contactId', requireAuth, verified, requireOrgMember('viewer'), (req, res) => {
  void contactsController.get(req, res);
});

router.patch(
  '/contacts/:contactId',
  requireAuth,
  verified,
  requireOrgMember('admin'),
  (req, res) => {
    void contactsController.update(req, res);
  },
);

router.post(
  '/contacts/:contactId/tags',
  requireAuth,
  verified,
  requireOrgMember('admin'),
  (req, res) => {
    void contactsController.addTag(req, res);
  },
);

router.delete(
  '/contacts/:contactId/tags/:tagId',
  requireAuth,
  verified,
  requireOrgMember('admin'),
  (req, res) => {
    void contactsController.removeTag(req, res);
  },
);

// --- Opt-in links ---------------------------------------------------------------------------
//
// The third contact-ingestion door, and the only one where the consent is created by the customer
// rather than asserted by the organization. Mounted here rather than under `/consent` because what it
// produces is contacts; the consent it records is how they arrive, not a policy setting.

router.get('/optin-links', requireAuth, verified, requireOrgMember('viewer'), (req, res) => {
  void optinLinksController.list(req, res);
});

router.post('/optin-links', requireAuth, verified, requireOrgMember('admin'), (req, res) => {
  void optinLinksController.create(req, res);
});

router.post(
  '/optin-links/:linkId/disable',
  requireAuth,
  verified,
  requireOrgMember('admin'),
  (req, res) => {
    void optinLinksController.disable(req, res);
  },
);

// --- Tags -----------------------------------------------------------------------------------

router.get('/tags', requireAuth, verified, requireOrgMember('viewer'), (req, res) => {
  void contactsController.listTags(req, res);
});

router.delete('/tags/:tagId', requireAuth, verified, requireOrgMember('admin'), (req, res) => {
  void contactsController.deleteTag(req, res);
});

// --- Segments -------------------------------------------------------------------------------

router.get('/segments', requireAuth, verified, requireOrgMember('viewer'), (req, res) => {
  void segmentsController.list(req, res);
});

// Declared before `/segments/:segmentId` so the literal "preview" can never be read as an id.
router.post('/segments/preview', requireAuth, verified, requireOrgMember('viewer'), (req, res) => {
  void segmentsController.preview(req, res);
});

router.post('/segments', requireAuth, verified, requireOrgMember('admin'), (req, res) => {
  void segmentsController.create(req, res);
});

router.get('/segments/:segmentId', requireAuth, verified, requireOrgMember('viewer'), (req, res) => {
  void segmentsController.get(req, res);
});

router.get(
  '/segments/:segmentId/members',
  requireAuth,
  verified,
  requireOrgMember('viewer'),
  (req, res) => {
    void segmentsController.listMembers(req, res);
  },
);

router.put('/segments/:segmentId', requireAuth, verified, requireOrgMember('admin'), (req, res) => {
  void segmentsController.update(req, res);
});

router.delete(
  '/segments/:segmentId',
  requireAuth,
  verified,
  requireOrgMember('admin'),
  (req, res) => {
    void segmentsController.remove(req, res);
  },
);

export default router;
