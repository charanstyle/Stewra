import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { callsController } from '../controllers/callsController.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireEmailVerification } from '../middleware/requireEmailVerification.js';

const router = Router();

const verified = (req: Request, res: Response, next: NextFunction): void => {
  void requireEmailVerification(req, res, next);
};

router.get('/turn-credentials', requireAuth, verified, (req, res) => {
  void callsController.turnCredentials(req, res);
});

router.put('/push-token', requireAuth, verified, (req, res) => {
  void callsController.registerPushToken(req, res);
});

router.get('/history', requireAuth, verified, (req, res) => {
  void callsController.history(req, res);
});

export default router;
