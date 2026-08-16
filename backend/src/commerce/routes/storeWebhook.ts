import express, { Router } from 'express';
import { storeWebhookController } from '../controllers/storeWebhookController.js';

const router = Router();

/**
 * Raw bytes, same as the Meta and payments webhooks: Apple's signature is over the exact body, and
 * a router mounted after express.json() would be verifying a re-serialization.
 *
 * `type: 'application/json'` covers both stores — Apple posts JSON, and a Pub/Sub push is a JSON
 * envelope with the notification base64'd inside it. The 1 MB cap is generous for either: an App
 * Store notification is a few kilobytes of JWS and a Pub/Sub message is smaller still.
 */
router.use(express.raw({ type: 'application/json', limit: '1mb' }));

/**
 * One path per store rather than `/:store`. An unknown store is then a 404 from the router, before
 * any body is read or any string is validated — there is no code path where a store name arrives
 * from a request and has to be trusted.
 */
router.post('/apple', (req, res) => {
  void storeWebhookController.receiveApple(req, res);
});

router.post('/google', (req, res) => {
  void storeWebhookController.receiveGoogle(req, res);
});

export default router;
