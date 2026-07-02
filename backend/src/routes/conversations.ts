import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { conversationsController } from '../controllers/conversationsController';
import { requireAuth } from '../middleware/requireAuth';
import { requireEmailVerification } from '../middleware/requireEmailVerification';

const router = Router();

const verified = (req: Request, res: Response, next: NextFunction): void => {
  void requireEmailVerification(req, res, next);
};

router.post('/', requireAuth, verified, (req, res) => {
  void conversationsController.create(req, res);
});

router.get('/', requireAuth, verified, (req, res) => {
  void conversationsController.list(req, res);
});

// Static path registered before the `/:id` param route so it isn't captured as an id.
router.get('/stewra', requireAuth, verified, (req, res) => {
  void conversationsController.getStewra(req, res);
});

router.get('/:id', requireAuth, verified, (req, res) => {
  void conversationsController.get(req, res);
});

router.post('/:id/participants', requireAuth, verified, (req, res) => {
  void conversationsController.addParticipants(req, res);
});

router.post('/:id/leave', requireAuth, verified, (req, res) => {
  void conversationsController.leave(req, res);
});

router.post('/:id/read', requireAuth, verified, (req, res) => {
  void conversationsController.markRead(req, res);
});

export default router;
