import express, { Router } from 'express';
import { metaWebhookController } from '../controllers/metaWebhookController.js';
import { verifyMetaSignature } from '../middleware/verifyMetaSignature.js';

const router = Router();

/**
 * The commerce plane's Meta webhook. UNAUTHENTICATED by necessity — Meta holds no Stewra credentials
 * — so the X-Hub-Signature-256 HMAC is the only gate, and it must run on the RAW request bytes.
 *
 * Hence `express.raw()` here, and hence this router is mounted BEFORE the global `express.json()` in
 * app.ts, alongside `/webhooks/whatsapp`. Re-serializing a parsed body is not byte-identical, so it
 * would break every signature.
 *
 * The limit is higher than the assistant webhook's: Meta batches, and one POST can carry traffic for
 * many conversations across many tenants.
 */
router.use(express.raw({ type: 'application/json', limit: '4mb' }));

router.get('/', (req, res) => {
  metaWebhookController.verify(req, res);
});

router.post('/', verifyMetaSignature, (req, res) => {
  metaWebhookController.receive(req, res);
});

export default router;
