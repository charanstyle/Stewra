import { Router } from 'express';
import { preferencesController } from '../controllers/preferencesController';
import { requireAuth } from '../middleware/requireAuth';

const router = Router();

// Durable per-user settings (e.g. how far back Gmail is pulled for insights).
router.get('/', requireAuth, (req, res) => {
  void preferencesController.get(req, res);
});

router.patch('/', requireAuth, (req, res) => {
  void preferencesController.update(req, res);
});

export default router;
