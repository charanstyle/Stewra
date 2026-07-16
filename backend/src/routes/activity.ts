import { Router } from 'express';
import { activityController } from '../controllers/activityController.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

// The plain-language activity feed: a read-only view over the append-only audit log.
router.get('/', requireAuth, (req, res) => {
  void activityController.list(req, res);
});

export default router;
