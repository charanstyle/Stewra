import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { spendCapsController } from '../controllers/spendCapsController.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireInstallAdmin } from '../../middleware/requireInstallAdmin.js';

const router = Router();

/**
 * Platform-operator routes — mounted at `/platform/spend-caps`, OUTSIDE `/orgs`, same shape as the
 * rate cards and for the same reason: spend headroom is granted by whoever carries the Meta bill,
 * and a client must never raise their own allowance. `requireOrgMember` — any role — must never
 * appear in this file. `requireInstallAdmin` checks email verification itself, which is why the
 * `verified` wrapper the org routes use is absent rather than forgotten.
 */
const gate = (req: Request, res: Response, next: NextFunction): void => {
  void requireInstallAdmin(req, res, next);
};

router.put('/', requireAuth, gate, (req, res) => {
  void spendCapsController.set(req, res);
});

router.get('/', requireAuth, gate, (req, res) => {
  void spendCapsController.list(req, res);
});

export default router;
