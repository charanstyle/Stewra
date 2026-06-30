import { Router } from 'express';
import { connectionController } from '../controllers/connectionController';
import { requireAuth } from '../middleware/requireAuth';

const router = Router();

// Start connecting a Google account (one consent grants read-only Calendar + Gmail).
router.post('/google/start', requireAuth, (req, res) => {
  void connectionController.startGoogle(req, res);
});

// Google redirects the browser here after consent — NO requireAuth; the signed state carries the user.
router.get('/google/callback', (req, res) => {
  void connectionController.googleCallback(req, res);
});

router.get('/', requireAuth, (req, res) => {
  void connectionController.list(req, res);
});

router.post('/:id/disconnect', requireAuth, (req, res) => {
  void connectionController.disconnect(req, res);
});

export default router;
