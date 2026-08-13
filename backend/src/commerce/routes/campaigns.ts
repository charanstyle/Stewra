import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { billingController } from '../controllers/billingController.js';
import { broadcastsController } from '../controllers/broadcastsController.js';
import { operationsController } from '../controllers/operationsController.js';
import { spendCapsController } from '../controllers/spendCapsController.js';
import { templatesController } from '../controllers/templatesController.js';
import { requireOrgMember } from '../middleware/requireOrgMember.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireEmailVerification } from '../../middleware/requireEmailVerification.js';

// `mergeParams` so `:orgId` from the parent mount reaches requireOrgMember.
const router = Router({ mergeParams: true });

const verified = (req: Request, res: Response, next: NextFunction): void => {
  void requireEmailVerification(req, res, next);
};

/**
 * The campaign surface — templates today, broadcasts alongside them — mounted under `/orgs/:orgId`.
 *
 * Reads are `viewer`; everything that touches Meta or reaches a member of the public is `marketer`.
 * That line sits one rank lower than the audience routes' `admin`, and deliberately: writing and
 * submitting a template is the marketing role's actual job, while editing a segment silently changes
 * who every future campaign reaches. Both still exclude `agent` and `viewer`, who work the inbox.
 *
 * `POST /templates/sync` is a read of Meta's state that stores the answer, so it is a POST — and it
 * is `marketer` rather than `viewer` because Meta rate-limits template reads per WABA, and a refresh
 * button anyone could hold down would spend the budget a campaign needs.
 */

// --- Templates --------------------------------------------------------------------------------

router.get('/templates', requireAuth, verified, requireOrgMember('viewer'), (req, res) => {
  void templatesController.list(req, res);
});

// Declared before any `/templates/:templateId` route so the literal "sync" is never read as an id.
router.post('/templates/sync', requireAuth, verified, requireOrgMember('marketer'), (req, res) => {
  void templatesController.sync(req, res);
});

router.post('/templates', requireAuth, verified, requireOrgMember('marketer'), (req, res) => {
  void templatesController.create(req, res);
});

router.delete(
  '/templates/:templateId',
  requireAuth,
  verified,
  requireOrgMember('marketer'),
  (req, res) => {
    void templatesController.remove(req, res);
  },
);

// --- Broadcasts -------------------------------------------------------------------------------
//
// Reads are `viewer`; preview is `marketer` (it evaluates a live audience, a marketer's tool);
// create, cancel and resume are `admin` — a broadcast spends the client's money and their phone
// number's reputation, and CreateBroadcastRequest's contract says admin in as many words.

router.get('/broadcasts', requireAuth, verified, requireOrgMember('viewer'), (req, res) => {
  void broadcastsController.list(req, res);
});

// Declared before any `/broadcasts/:broadcastId` route so the literal "preview" is never an id.
router.post(
  '/broadcasts/preview',
  requireAuth,
  verified,
  requireOrgMember('marketer'),
  (req, res) => {
    void broadcastsController.preview(req, res);
  },
);

router.post('/broadcasts', requireAuth, verified, requireOrgMember('admin'), (req, res) => {
  void broadcastsController.create(req, res);
});

router.get(
  '/broadcasts/:broadcastId',
  requireAuth,
  verified,
  requireOrgMember('viewer'),
  (req, res) => {
    void broadcastsController.get(req, res);
  },
);

router.post(
  '/broadcasts/:broadcastId/cancel',
  requireAuth,
  verified,
  requireOrgMember('admin'),
  (req, res) => {
    void broadcastsController.cancel(req, res);
  },
);

router.post(
  '/broadcasts/:broadcastId/resume',
  requireAuth,
  verified,
  requireOrgMember('admin'),
  (req, res) => {
    void broadcastsController.resume(req, res);
  },
);

router.get(
  '/broadcasts/:broadcastId/recipients',
  requireAuth,
  verified,
  requireOrgMember('viewer'),
  (req, res) => {
    void broadcastsController.listRecipients(req, res);
  },
);

// --- Costs and the job queue ------------------------------------------------------------------

// `admin`: this is the billing input, not campaign telemetry.
router.get('/costs', requireAuth, verified, requireOrgMember('admin'), (req, res) => {
  void operationsController.costs(req, res);
});

// `viewer`: read-only. The cap itself is granted on the platform surface, never here — but the
// person watching a campaign the cap paused deserves the explanation without asking an admin.
router.get('/spend', requireAuth, verified, requireOrgMember('viewer'), (req, res) => {
  void spendCapsController.orgSpend(req, res);
});

router.get('/jobs', requireAuth, verified, requireOrgMember('viewer'), (req, res) => {
  void operationsController.jobs(req, res);
});

// --- Billing (read-only on this surface) ------------------------------------------------------
//
// `admin`, matching `/costs`: what the org is billed is the owner/admin's business, not the
// inbox's. Plans and subscriptions are WRITTEN only on `/platform/billing` — never here.

router.get('/billing', requireAuth, verified, requireOrgMember('admin'), (req, res) => {
  void billingController.orgBilling(req, res);
});

router.get('/invoices', requireAuth, verified, requireOrgMember('admin'), (req, res) => {
  void billingController.listInvoices(req, res);
});

router.get(
  '/invoices/:invoiceId',
  requireAuth,
  verified,
  requireOrgMember('admin'),
  (req, res) => {
    void billingController.getInvoice(req, res);
  },
);

export default router;
