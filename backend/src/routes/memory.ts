import { Router } from 'express';
import { memoryController } from '../controllers/memoryController.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireEmailVerification } from '../middleware/requireEmailVerification.js';

const router = Router();

// The user-owned learning store ("things I've learned about you"). Mounted under /memory. Every
// route is gated the same way the rest of the agent surface is (auth + verified email). This is the
// user's own store, so it's read/edited/deleted directly (not through the broker), but every write
// and delete is audited in the service (memory-and-learning.md §5).
router.use(requireAuth, (req, res, next) => {
  void requireEmailVerification(req, res, next);
});

// GET /memory — list the user's learnings, optional ?search= and ?kind= filters.
router.get('/', (req, res) => {
  void memoryController.list(req, res);
});

// PATCH /memory/:id — rename the label, revise/clear guidance, or toggle recall visibility.
router.patch('/:id', (req, res) => {
  void memoryController.update(req, res);
});

// DELETE /memory/:id — really forget one learning (no soft-delete).
router.delete('/:id', (req, res) => {
  void memoryController.remove(req, res);
});

export default router;
