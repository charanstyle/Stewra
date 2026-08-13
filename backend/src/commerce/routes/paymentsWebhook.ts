import express, { Router } from 'express';
import { paymentsWebhookController } from '../controllers/paymentsWebhookController.js';

const router = Router();

// Raw bytes, same as the Meta webhook: the provider's signature is over the exact body, and a
// router mounted after express.json() would be verifying a re-serialization.
router.use(express.raw({ type: 'application/json', limit: '1mb' }));

router.post('/', (req, res) => {
  void paymentsWebhookController.receive(req, res);
});

export default router;
