import express, { Router } from 'express';
import { telnyxController } from '../controllers/telnyxController.js';
import { verifyTelnyxSignature } from '../middleware/verifyTelnyxSignature.js';

const router = Router();

/**
 * Telnyx's webhook for the install's own numbers. Unauthenticated by necessity, so the Ed25519
 * signature over the RAW bytes is the only gate — hence `express.raw()` here and a mount in app.ts
 * BEFORE the global `express.json()`, exactly like the Meta webhooks.
 */
router.use(express.raw({ type: 'application/json', limit: '1mb' }));

router.post('/', verifyTelnyxSignature, (req, res) => {
  telnyxController.receive(req, res);
});

export default router;
