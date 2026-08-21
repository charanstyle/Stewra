import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { machineAccessController } from '../controllers/machineAccessController.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireEmailVerification } from '../middleware/requireEmailVerification.js';
import { requireOrgMember } from '../tenancy/middleware/requireOrgMember.js';

/**
 * `/orgs/:orgId/machine-access` — requests from a Stewra Bridge to see the machine it runs on.
 *
 * Any member may SEE what has been asked of their org; only an admin decides. Deciding is what turns a
 * matched pair of devices into permission for someone outside the org, so it sits at the same level as
 * pairing a machine or moving one between orgs.
 */
const router = Router({ mergeParams: true });

const verified = (req: Request, res: Response, next: NextFunction): void => {
  void requireEmailVerification(req, res, next);
};

const read = [requireAuth, verified, requireOrgMember('viewer')] as const;
const write = [requireAuth, verified, requireOrgMember('admin')] as const;

router.get('/', ...read, (req, res, next) => {
  void machineAccessController.list(req, res, next);
});
router.post('/:requestId/decide', ...write, (req, res, next) => {
  void machineAccessController.decide(req, res, next);
});

export default router;
