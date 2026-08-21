import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { conversationsController } from '../controllers/conversationsController.js';
import { requireOrgMember } from '../../tenancy/middleware/requireOrgMember.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireEmailVerification } from '../../middleware/requireEmailVerification.js';

// `mergeParams` so `:orgId` from the parent mount reaches requireOrgMember.
const router = Router({ mergeParams: true });

const verified = (req: Request, res: Response, next: NextFunction): void => {
  void requireEmailVerification(req, res, next);
};

router.get('/', requireAuth, verified, requireOrgMember('viewer'), (req, res) => {
  void conversationsController.list(req, res);
});

router.get(
  '/:conversationId/messages',
  requireAuth,
  verified,
  requireOrgMember('viewer'),
  (req, res) => {
    void conversationsController.listMessages(req, res);
  },
);

// `agent` is the role that works the inbox — the lowest one that may put words in front of a
// customer. A `viewer` reading the thread above must not be able to answer it.
router.post(
  '/:conversationId/messages',
  requireAuth,
  verified,
  requireOrgMember('agent'),
  (req, res) => {
    void conversationsController.reply(req, res);
  },
);

// Same role as a reply, on purpose: one template to one customer in an existing thread is inbox
// work, not a campaign. The consent gate inside the service is what makes a marketing-category
// template face the full marketing rules regardless of who clicks send.
router.post(
  '/:conversationId/template-messages',
  requireAuth,
  verified,
  requireOrgMember('agent'),
  (req, res) => {
    void conversationsController.sendTemplate(req, res);
  },
);

export default router;
