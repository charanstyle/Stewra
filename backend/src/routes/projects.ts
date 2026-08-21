import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { projectsController } from '../controllers/projectsController.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireEmailVerification } from '../middleware/requireEmailVerification.js';
import { requireOrgMember } from '../tenancy/middleware/requireOrgMember.js';

/**
 * `/orgs/:orgId/projects`. `viewer` reads, `admin` writes. The org is always the path segment.
 * `/bindings` is declared before `/:projectId` so the literal can never be captured as an id.
 */
const router = Router({ mergeParams: true });

const verified = (req: Request, res: Response, next: NextFunction): void => {
  void requireEmailVerification(req, res, next);
};

const read = [requireAuth, verified, requireOrgMember('viewer')] as const;
const write = [requireAuth, verified, requireOrgMember('admin')] as const;

router.get('/', ...read, (req, res, next) => {
  void projectsController.list(req, res, next);
});
router.get('/bindings', ...read, (req, res, next) => {
  void projectsController.listOrgBindings(req, res, next);
});
router.post('/', ...write, (req, res, next) => {
  void projectsController.create(req, res, next);
});
router.get('/:projectId', ...read, (req, res, next) => {
  void projectsController.get(req, res, next);
});
router.patch('/:projectId', ...write, (req, res, next) => {
  void projectsController.update(req, res, next);
});
router.post('/:projectId/archive', ...write, (req, res, next) => {
  void projectsController.archive(req, res, next);
});
router.get('/:projectId/workspaces', ...read, (req, res, next) => {
  void projectsController.listBindings(req, res, next);
});
router.post('/:projectId/workspaces', ...write, (req, res, next) => {
  void projectsController.bind(req, res, next);
});
router.delete('/:projectId/workspaces/:bindingId', ...write, (req, res, next) => {
  void projectsController.unbind(req, res, next);
});

export default router;
