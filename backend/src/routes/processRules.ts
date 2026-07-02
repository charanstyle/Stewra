import { Router } from 'express';
import { processRulesController } from '../controllers/processRulesController';
import { requireAuth } from '../middleware/requireAuth';
import { requireEmailVerification } from '../middleware/requireEmailVerification';

const router = Router();

// The user-owned process/style store ("how I like work done"). Mounted under /process-rules. Gated
// like the rest of the agent surface (auth + verified email). This is the user's own store, so it's
// read/edited/deleted directly (not through the broker), but every write and delete is audited in the
// service (memory-and-learning.md §5). Machine-proposed rules land here as `proposed` for the user to
// confirm; the routes below are the user-authored path (state, list, confirm/edit, forget).
router.use(requireAuth, (req, res, next) => {
  void requireEmailVerification(req, res, next);
});

// GET /process-rules — list the user's rules, optional ?domain=/?status=/?search= filters.
router.get('/', (req, res) => {
  void processRulesController.list(req, res);
});

// POST /process-rules — state a rule directly (created `active`).
router.post('/', (req, res) => {
  void processRulesController.create(req, res);
});

// PATCH /process-rules/:id — revise text, confirm/mute via status, or toggle recall visibility.
router.patch('/:id', (req, res) => {
  void processRulesController.update(req, res);
});

// DELETE /process-rules/:id — really forget one rule (no soft-delete).
router.delete('/:id', (req, res) => {
  void processRulesController.remove(req, res);
});

export default router;
