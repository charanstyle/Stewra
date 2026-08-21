import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { orgRunnerController } from '../controllers/orgRunnerController.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireEmailVerification } from '../middleware/requireEmailVerification.js';
import { requireOrgMember } from '../tenancy/middleware/requireOrgMember.js';

/**
 * `/orgs/:orgId/runner` — the org-scoped runner surface. Mounted in app.ts with `mergeParams` so the
 * `:orgId` the parent path captured reaches `requireOrgMember`. `viewer` reads; `admin` does everything
 * else — pairing a machine, relabelling it, starting a session on it. There is no `developer` role:
 * `roleMeetsMinimum` is positional, and a role slotted between admin and marketer would silently gain
 * the commerce plane's broadcast rights.
 */
const router = Router({ mergeParams: true });

const verified = (req: Request, res: Response, next: NextFunction): void => {
  void requireEmailVerification(req, res, next);
};

const read = [requireAuth, verified, requireOrgMember('viewer')] as const;
const write = [requireAuth, verified, requireOrgMember('admin')] as const;

router.get('/', ...read, (req, res, next) => {
  void orgRunnerController.status(req, res, next);
});
router.get('/devices', ...read, (req, res, next) => {
  void orgRunnerController.listDevices(req, res, next);
});
router.post('/pair', ...write, (req, res, next) => {
  void orgRunnerController.startPairing(req, res, next);
});
router.patch('/devices/:id', ...write, (req, res, next) => {
  void orgRunnerController.updateDevice(req, res, next);
});
router.post('/devices/:id/move', ...write, (req, res, next) => {
  void orgRunnerController.moveDevice(req, res, next);
});
router.post('/devices/:id/rescan', ...write, (req, res, next) => {
  void orgRunnerController.rescanDevice(req, res, next);
});
router.delete('/devices/:id', ...write, (req, res, next) => {
  void orgRunnerController.revokeDevice(req, res, next);
});

router.get('/sessions', ...read, (req, res, next) => {
  void orgRunnerController.listSessions(req, res, next);
});
router.get('/sessions/:id', ...read, (req, res, next) => {
  void orgRunnerController.getSession(req, res, next);
});
router.post('/sessions', ...write, (req, res, next) => {
  void orgRunnerController.startSession(req, res, next);
});
router.post('/sessions/:id/prompt', ...write, (req, res, next) => {
  void orgRunnerController.promptSession(req, res, next);
});
router.post('/sessions/:id/permission', ...write, (req, res, next) => {
  void orgRunnerController.decidePermission(req, res, next);
});
router.post('/sessions/:id/cancel', ...write, (req, res, next) => {
  void orgRunnerController.cancelSession(req, res, next);
});
router.post('/sessions/:id/push', ...write, (req, res, next) => {
  void orgRunnerController.pushSession(req, res, next);
});
router.post('/sessions/:id/pr', ...write, (req, res, next) => {
  void orgRunnerController.openPr(req, res, next);
});

export default router;
