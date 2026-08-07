import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { channelsController } from '../controllers/channelsController.js';
import { requireOrgMember } from '../middleware/requireOrgMember.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireEmailVerification } from '../../middleware/requireEmailVerification.js';

// `mergeParams` so `:orgId` from the parent mount reaches requireOrgMember. Without it the middleware
// sees no org id and every route here 404s — a silent, total outage of the connect surface.
const router = Router({ mergeParams: true });

const verified = (req: Request, res: Response, next: NextFunction): void => {
  void requireEmailVerification(req, res, next);
};

// Reading which channels are connected is part of seeing the org at all.
router.get('/', requireAuth, verified, requireOrgMember('viewer'), (req, res) => {
  void channelsController.list(req, res);
});

// `marketer` connects a channel: it is the role that owns how the business reaches its customers.
// Disconnecting is `admin` — it severs an active line to every customer at once, and that asymmetry
// is deliberate rather than an oversight.
router.post('/whatsapp', requireAuth, verified, requireOrgMember('marketer'), (req, res) => {
  void channelsController.connectWhatsapp(req, res);
});

router.delete('/:accountId', requireAuth, verified, requireOrgMember('admin'), (req, res) => {
  void channelsController.disconnect(req, res);
});

export default router;
