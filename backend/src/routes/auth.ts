import { Router } from 'express';
import { authController } from '../controllers/authController.js';
import { requireAuth } from '../middleware/requireAuth.js';

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
// Password reset for logged-out users: request a code, then confirm code + new password. Both public.
router.post('/password-reset/request', (req, res) => {
  void authController.requestPasswordReset(req, res);
});
router.post('/password-reset/confirm', (req, res) => {
  void authController.confirmPasswordReset(req, res);
});
router.get('/me', requireAuth, (req, res) => {
  void authController.me(req, res);
});

export default router;
