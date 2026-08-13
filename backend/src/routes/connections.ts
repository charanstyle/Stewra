import { Router } from 'express';
import { connectionController } from '../controllers/connectionController.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireEmailVerification } from '../middleware/requireEmailVerification.js';

const router = Router();

// Start connecting a Google account (one consent grants read-only Calendar + Gmail).
// Gated on a verified email — no data connections until the account owner is confirmed.
router.post('/google/start', requireAuth, (req, res, next) => {
  void requireEmailVerification(req, res, next);
}, (req, res) => {
  void connectionController.startGoogle(req, res);
});

// Google redirects the browser here after consent — NO requireAuth; the signed state carries the user.
router.get('/google/callback', (req, res) => {
  void connectionController.googleCallback(req, res);
});

// Start connecting a bank (Plaid Link): consent prompt + a short-lived Link token. Same
// verified-email gate as Google — no data connections until the account owner is confirmed.
router.post('/plaid/start', requireAuth, (req, res, next) => {
  void requireEmailVerification(req, res, next);
}, (req, res) => {
  void connectionController.startPlaid(req, res);
});

// Link hands the client a one-time public token; this authenticated call exchanges it server-side.
router.post('/plaid/exchange', requireAuth, (req, res, next) => {
  void requireEmailVerification(req, res, next);
}, (req, res) => {
  void connectionController.exchangePlaid(req, res);
});

router.get('/', requireAuth, (req, res) => {
  void connectionController.list(req, res);
});

router.post('/:id/disconnect', requireAuth, (req, res) => {
  void connectionController.disconnect(req, res);
});

export default router;
