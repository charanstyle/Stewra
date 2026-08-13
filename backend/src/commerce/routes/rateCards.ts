import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { rateCardsController } from '../controllers/rateCardsController.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireInstallAdmin } from '../../middleware/requireInstallAdmin.js';

const router = Router();

/**
 * Platform-operator routes — mounted at `/platform/rate-cards`, OUTSIDE `/orgs`.
 *
 * Every line here is requireAuth + requireInstallAdmin and nothing org-scoped: the price list is
 * install-wide data that organizations are billed FROM, so `requireOrgMember` — any role — must
 * never appear in this file. `requireInstallAdmin` checks email verification itself, which is why
 * the `verified` wrapper the org routes use is absent rather than forgotten.
 */
const gate = (req: Request, res: Response, next: NextFunction): void => {
  void requireInstallAdmin(req, res, next);
};

router.post('/', requireAuth, gate, (req, res) => {
  void rateCardsController.load(req, res);
});

router.get('/', requireAuth, gate, (req, res) => {
  void rateCardsController.list(req, res);
});

router.get('/:cardId', requireAuth, gate, (req, res) => {
  void rateCardsController.get(req, res);
});

export default router;
