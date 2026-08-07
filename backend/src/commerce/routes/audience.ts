import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { contactsController } from '../controllers/contactsController.js';
import { segmentsController } from '../controllers/segmentsController.js';
import { requireOrgMember } from '../middleware/requireOrgMember.js';
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
