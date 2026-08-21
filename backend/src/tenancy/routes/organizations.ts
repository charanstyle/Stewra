import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { organizationsController } from '../controllers/organizationsController.js';
import { requireOrgMember } from '../middleware/requireOrgMember.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { requireEmailVerification } from '../../middleware/requireEmailVerification.js';

const router = Router();

// Every commerce route requires a signed-in, email-verified account. Verification matters more here
// than on the personal-assistant routes: an unverified address is how someone would claim a business
// they do not own and then invite themselves teammates.
const verified = (req: Request, res: Response, next: NextFunction): void => {
  void requireEmailVerification(req, res, next);
};

// --- Not org-scoped -------------------------------------------------------------------------
// These three cannot sit behind requireOrgMember: the first creates the org, and the other two name
// it in the body or the token rather than the path. Each re-checks the caller's relationship to the
// org itself — see organizationService.setActiveOrg and acceptInvite.
//
// They are declared BEFORE `/:orgId` so a literal path segment can never be captured as an org id.

router.post('/', requireAuth, verified, (req, res) => {
  void organizationsController.create(req, res);
});

router.get('/', requireAuth, verified, (req, res) => {
  void organizationsController.list(req, res);
});

router.put('/active', requireAuth, verified, (req, res) => {
  void organizationsController.setActive(req, res);
});

router.post('/invites/accept', requireAuth, verified, (req, res) => {
  void organizationsController.acceptInvite(req, res);
});

// --- Org-scoped -----------------------------------------------------------------------------
// The minimum role on each line is the whole authorization model for this resource. `viewer` reads,
// `admin` changes who is in the org. Nothing here is reachable without requireOrgMember.

router.get('/:orgId', requireAuth, verified, requireOrgMember('viewer'), (req, res) => {
  void organizationsController.get(req, res);
});

// `owner` here and re-checked in the service: converting is the act that unlocks invites, so it
// carries the same authority as granting the owner role itself.
router.post('/:orgId/convert', requireAuth, verified, requireOrgMember('owner'), (req, res) => {
  void organizationsController.convert(req, res);
});

router.get('/:orgId/members', requireAuth, verified, requireOrgMember('viewer'), (req, res) => {
  void organizationsController.listMembers(req, res);
});

router.post('/:orgId/invites', requireAuth, verified, requireOrgMember('admin'), (req, res) => {
  void organizationsController.createInvite(req, res);
});

router.delete(
  '/:orgId/invites/:inviteId',
  requireAuth,
  verified,
  requireOrgMember('admin'),
  (req, res) => {
    void organizationsController.revokeInvite(req, res);
  },
);

router.patch(
  '/:orgId/members/:memberId',
  requireAuth,
  verified,
  requireOrgMember('admin'),
  (req, res) => {
    void organizationsController.updateMember(req, res);
  },
);

router.delete(
  '/:orgId/members/:memberId',
  requireAuth,
  verified,
  requireOrgMember('admin'),
  (req, res) => {
    void organizationsController.removeMember(req, res);
  },
);

// The rest of the commerce surface also hangs off `/orgs/:orgId`, but it is NOT mounted here: this
// file is tenancy, an install-wide primitive, and `.dependency-cruiser.cjs` forbids it from importing
// `commerce/`. Those sub-routers are mounted next to this router in `backend/src/app.ts` — the
// composition root — via `commerce/routes/orgSurface.ts`. The resulting URLs are unchanged.

export default router;
