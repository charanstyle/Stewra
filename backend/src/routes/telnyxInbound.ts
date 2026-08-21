import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { telnyxController } from '../controllers/telnyxController.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireInstallAdmin } from '../middleware/requireInstallAdmin.js';

const router = Router();

/**
 * Platform-operator read of the Telnyx inbox — mounted at `/platform/telnyx/inbound`, outside `/orgs`.
 * The numbers belong to the install, not to any organization, so it is requireAuth + requireInstallAdmin
 * and nothing org-scoped, like the rate cards.
 */
const gate = (req: Request, res: Response, next: NextFunction): void => {
  void requireInstallAdmin(req, res, next);
};

router.get('/:number', requireAuth, gate, (req, res) => {
  void telnyxController.list(req, res);
});

export default router;
