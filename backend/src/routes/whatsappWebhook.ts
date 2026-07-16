import express, { Router } from 'express';
import { whatsappController } from '../controllers/whatsappController.js';
import { verifyWhatsappSignature } from '../middleware/verifyWhatsappSignature.js';

const router = Router();

/**
 * Meta's webhook. UNAUTHENTICATED by necessity — Meta holds no Stewra credentials — so the
 * X-Hub-Signature-256 HMAC is the only gate, and it must run on the RAW request bytes.
 *
 * Hence `express.raw()` here, and hence this router is mounted BEFORE the global `express.json()` in
 * app.ts. Re-serializing a parsed body is not byte-identical, so it would break every signature.
 */
router.use(express.raw({ type: 'application/json', limit: '1mb' }));

// Subscription handshake: echo hub.challenge as plain text.
router.get('/', (req, res) => {
  whatsappController.verify(req, res);
});

// Inbound messages. Signature first; the handler 200s immediately and works off the request path.
router.post('/', verifyWhatsappSignature, (req, res) => {
  whatsappController.receive(req, res);
});

export default router;
