import type { Request, Response } from 'express';
import * as Sentry from '@sentry/node';
import { BaseController } from '../../controllers/baseController.js';
import { buildPaymentProvider } from '../services/payments/index.js';
import { paymentService } from '../services/paymentService.js';
import { logger } from '../../utils/logger.js';

/**
 * The payment provider's webhook — mounted on a raw-body router BEFORE express.json, same as
 * /webhooks/meta, because the signature is over the exact bytes.
 *
 * Verification happens through the PORT (`provider.verifyWebhook`), not here: this controller
 * never learns a provider's event shape or signature scheme. Under the `manual` provider the port
 * throws for every delivery — there is no webhook to be genuine.
 *
 * ACK-then-work, like the Meta webhook: once the event is verified and normalized, the provider
 * gets its 200 before the database is touched, and replays are absorbed by `applyEvent` finding
 * no pending attempt.
 */
class PaymentsWebhookController extends BaseController {
  /** POST /webhooks/payments */
  async receive(req: Request, res: Response): Promise<void> {
    try {
      if (!Buffer.isBuffer(req.body)) {
        throw new Error(
          'payments webhook: raw body unavailable — the webhook router must be mounted before express.json()',
        );
      }
      const signature = req.get('stripe-signature') ?? null;
      const event = buildPaymentProvider().verifyWebhook(req.body, signature);
      res.sendStatus(200);
      try {
        await paymentService.applyEvent(event);
      } catch (error) {
        // Already ACKed: the provider will not retry, so this failure must be loud somewhere else.
        logger.error('commerce payments: verified webhook event failed to apply', {
          error: error instanceof Error ? error.message : String(error),
        });
        Sentry.captureException(error);
      }
    } catch (error) {
      this.handleError(error, res, 'PaymentsWebhookController.receive');
    }
  }
}

export const paymentsWebhookController = new PaymentsWebhookController();
