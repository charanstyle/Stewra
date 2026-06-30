import { Router } from 'express';
import { insightController } from '../controllers/insightController';
import { requireAuth } from '../middleware/requireAuth';
import { requireEmailVerification } from '../middleware/requireEmailVerification';

const router = Router();

// Produce one advice-only insight over a connected resource (the control plane records it).
// Gated on a verified email — no insights until the account owner is confirmed.
router.post('/', requireAuth, (req, res, next) => {
  void requireEmailVerification(req, res, next);
}, (req, res) => {
  void insightController.generate(req, res);
});

export default router;
