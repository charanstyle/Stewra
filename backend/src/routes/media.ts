import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { mediaController } from '../controllers/mediaController';
import { requireAuth } from '../middleware/requireAuth';
import { requireEmailVerification } from '../middleware/requireEmailVerification';

const router = Router();

const verified = (req: Request, res: Response, next: NextFunction): void => {
  void requireEmailVerification(req, res, next);
};

// Stored audio/media is never served statically — every read is authorized (owner or participant).
router.get('/:id', requireAuth, verified, (req, res) => {
  void mediaController.get(req, res);
});

export default router;
