import { Router } from 'express';
import { homeController } from '../controllers/homeController.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireEmailVerification } from '../middleware/requireEmailVerification.js';

const router = Router();

/** The proactive briefing + nudges the background job computed. Read-only — just requires auth. */
router.get('/briefing', requireAuth, (req, res) => {
  void homeController.getBriefing(req, res);
});

router.get('/suggestions', requireAuth, (req, res) => {
  void homeController.listSuggestions(req, res);
});

// Nudge lifecycle — snooze/dismiss/mark-done. Auth only (no model call, no mail read).
router.post('/suggestions/:id/snooze', requireAuth, (req, res) => {
  void homeController.snooze(req, res);
});
router.post('/suggestions/:id/dismiss', requireAuth, (req, res) => {
  void homeController.dismiss(req, res);
});
router.post('/suggestions/:id/done', requireAuth, (req, res) => {
  void homeController.markDone(req, res);
});

// Draft / chat / recompute touch the model + stored mail — gated on a verified email, like insights.
router.post(
  '/suggestions/:id/draft',
  requireAuth,
  (req, res, next) => {
    void requireEmailVerification(req, res, next);
  },
  (req, res) => {
    void homeController.draft(req, res);
  },
);
router.post(
  '/suggestions/:id/chat',
  requireAuth,
  (req, res, next) => {
    void requireEmailVerification(req, res, next);
  },
  (req, res) => {
    void homeController.chat(req, res);
  },
);
router.post(
  '/recompute',
  requireAuth,
  (req, res, next) => {
    void requireEmailVerification(req, res, next);
  },
  (req, res) => {
    void homeController.recompute(req, res);
  },
);

export default router;
