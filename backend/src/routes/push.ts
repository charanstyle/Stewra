import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { pushController } from '../controllers/pushController.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireEmailVerification } from '../middleware/requireEmailVerification.js';

const router = Router();

const verified = (req: Request, res: Response, next: NextFunction): void => {
  void requireEmailVerification(req, res, next);
};

router.put('/token', requireAuth, verified, (req, res) => {
  void pushController.registerToken(req, res);
});

export default router;
