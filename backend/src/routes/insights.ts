import { Router } from 'express';
import { insightController } from '../controllers/insightController';
import { requireAuth } from '../middleware/requireAuth';

const router = Router();

// Produce one advice-only insight over a connected resource (the control plane records it).
router.post('/', requireAuth, (req, res) => {
  void insightController.generate(req, res);
});

export default router;
