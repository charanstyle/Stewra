import { Router } from 'express';
import { emailVerificationController } from '../controllers/emailVerificationController.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

// Both endpoints need an authenticated user but NOT a verified one — that's the whole point.
router.post('/verify', requireAuth, (req, res) => {
  void emailVerificationController.verify(req, res);
});

router.post('/resend', requireAuth, (req, res) => {
  void emailVerificationController.resend(req, res);
});

export default router;
