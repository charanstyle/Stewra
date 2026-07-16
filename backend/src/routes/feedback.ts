import { Router } from 'express';
import { feedbackController } from '../controllers/feedbackController.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireEmailVerification } from '../middleware/requireEmailVerification.js';

const router = Router();

// Record the user's verdict on one insight. Mounted under /insights, so the full path is
// POST /insights/:insightId/feedback. Gated the same way insights are (auth + verified email).
router.post('/:insightId/feedback', requireAuth, (req, res, next) => {
  void requireEmailVerification(req, res, next);
}, (req, res) => {
  void feedbackController.submit(req, res);
});

export default router;
