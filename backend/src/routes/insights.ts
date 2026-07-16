import { Router } from 'express';
import { insightController } from '../controllers/insightController.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireEmailVerification } from '../middleware/requireEmailVerification.js';

const router = Router();

// Produce one advice-only insight over a connected resource (the control plane records it).
// Gated on a verified email — no insights until the account owner is confirmed.
router.post('/', requireAuth, (req, res, next) => {
  void requireEmailVerification(req, res, next);
}, (req, res) => {
  void insightController.generate(req, res);
});

// Record that an insight was surfaced to the user (passive impression) — first-write-wins, no reward.
router.post('/:insightId/seen', requireAuth, (req, res, next) => {
  void requireEmailVerification(req, res, next);
}, (req, res) => {
  void insightController.markSeen(req, res);
});

// Record the user dismissing an insight without rating it — the implicit "not useful" signal.
router.post('/:insightId/dismissed', requireAuth, (req, res, next) => {
  void requireEmailVerification(req, res, next);
}, (req, res) => {
  void insightController.markDismissed(req, res);
});

export default router;
