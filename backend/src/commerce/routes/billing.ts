import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { billingController } from '../controllers/billingController.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireInstallAdmin } from '../../middleware/requireInstallAdmin.js';

const router = Router();

/**
 * Platform-operator routes — mounted at `/platform/billing`, OUTSIDE `/orgs`, same shape as the
 * rate cards and spend caps and for the same reason: the plan catalog and who subscribes to what
 * decide what clients are charged, and a client must never edit either. `requireOrgMember` — any
 * role — must never appear in this file. `requireInstallAdmin` checks email verification itself,
 * which is why the `verified` wrapper the org routes use is absent rather than forgotten.
 */
const gate = (req: Request, res: Response, next: NextFunction): void => {
  void requireInstallAdmin(req, res, next);
};

router.put('/plans', requireAuth, gate, (req, res) => {
  void billingController.upsertPlan(req, res);
});

router.get('/plans', requireAuth, gate, (req, res) => {
  void billingController.listPlans(req, res);
});

router.put('/subscriptions', requireAuth, gate, (req, res) => {
  void billingController.setSubscription(req, res);
});

// Settlement, both kinds: an operator attesting an offline payment, and a charge through the
// configured provider. Named actions as POSTs — each one creates an attempt row.
router.post('/invoices/:invoiceId/mark-paid', requireAuth, gate, (req, res) => {
  void billingController.markInvoicePaid(req, res);
});

router.post('/invoices/:invoiceId/charge', requireAuth, gate, (req, res) => {
  void billingController.chargeInvoice(req, res);
});

export default router;
