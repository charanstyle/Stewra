import { Router } from 'express';
import { authController } from '../controllers/authController';
import { requireAuth } from '../middleware/requireAuth';

const router = Router();

router.post('/register', (req, res) => {
  void authController.register(req, res);
});
router.post('/login', (req, res) => {
  void authController.login(req, res);
});
router.post('/refresh', (req, res) => {
  void authController.refresh(req, res);
});
router.get('/me', requireAuth, (req, res) => {
  void authController.me(req, res);
});

export default router;
