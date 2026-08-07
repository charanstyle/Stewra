import type { Request, Response } from 'express';
import { z } from 'zod';
import * as Sentry from '@sentry/node';
import { BaseController } from '../../controllers/baseController.js';
import { commerceInboundService } from '../services/commerceInboundService.js';
import { whatsappInboundAdapter } from '../services/inbound/whatsappAdapter.js';
import { config } from '../../config/unifiedConfig.js';
import { ServiceUnavailableError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

/** The outer envelope. `object` says which product the entries belong to; entries are per-account. */
const envelopeSchema = z.object({
  object: z.string(),
  entry: z.array(z.unknown()).optional(),
});

/** Meta's GET handshake when the callback URL is first registered. */
const verifySchema = z.object({
  'hub.mode': z.string(),
  'hub.verify_token': z.string(),
  'hub.challenge': z.string(),
});

/**
 * `POST /webhooks/meta` — ONE URL for every tenant.
 *
 * That is the whole difference from `/webhooks/whatsapp`. The assistant's webhook has exactly one
 * business number behind it, so a verified payload is by definition for us. Here, a verified payload
 * could be for any of hundreds of organizations, and the only thing that says which is the account id
 * inside it. Routing therefore happens per message, in `commerceInboundService`, and an unrecognised
 * account is dropped rather than defaulted.
 *
 * ACK THEN WORK, like the assistant's webhook: Meta retries for up to seven days until it sees a 200,
 * so holding the response open while writing rows earns duplicate deliveries of messages already
 * being handled. Each message is separately deduped on its provider id, which is the real guarantee.
 */
class MetaWebhookController extends BaseController {
  private assertEnabled(): void {
    if (!config.metaCommerce.enabled) {
      throw new ServiceUnavailableError('The commerce webhook is not configured.');
    }
  }

  /** GET /webhooks/meta — echo `hub.challenge` as PLAIN TEXT or Meta rejects the endpoint. */
  verify(req: Request, res: Response): void {
    try {
      this.assertEnabled();
      const meta = config.metaCommerce;
      const query = verifySchema.safeParse(req.query);
      if (
        !query.success ||
        query.data['hub.mode'] !== 'subscribe' ||
        !meta.enabled ||
        query.data['hub.verify_token'] !== meta.verifyToken
      ) {
        logger.warn('commerce webhook: verification handshake rejected');
        res.sendStatus(403);
        return;
      }
      res.status(200).type('text/plain').send(query.data['hub.challenge']);
    } catch (error) {
      this.handleError(error, res, 'MetaWebhookController.verify');
    }
  }

  /** POST /webhooks/meta — inbound traffic for every connected organization. */
  receive(req: Request, res: Response): void {
    try {
      this.assertEnabled();

      // The signature middleware needs raw bytes, so the body is still a Buffer at this point.
      const parsed = envelopeSchema.safeParse(JSON.parse(req.body.toString('utf8')));
      if (!parsed.success) {
        // Authentically Meta's, but a shape we do not know. 200 anyway or it retries for a week.
        logger.warn('commerce webhook: unrecognized envelope; acking to stop retries');
        res.sendStatus(200);
        return;
      }

      res.sendStatus(200);

      // Only WhatsApp today. Instagram and Messenger arrive under different `object` values and get
      // their own adapters; until then, saying so beats silently discarding them.
      if (parsed.data.object !== 'whatsapp_business_account') {
        logger.warn('commerce webhook: no adapter for this product; ignoring', {
          object: parsed.data.object,
        });
        return;
      }

      for (const entry of parsed.data.entry ?? []) {
        for (const message of whatsappInboundAdapter.normalize(entry)) {
          void commerceInboundService.handle(message).catch((error: unknown) => {
            Sentry.captureException(error);
            logger.error('commerce webhook: inbound dispatch failed', {
              providerMessageId: message.providerMessageId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
        for (const receipt of whatsappInboundAdapter.normalizeReceipts(entry)) {
          void commerceInboundService.handleReceipt(receipt).catch((error: unknown) => {
            Sentry.captureException(error);
            logger.error('commerce webhook: receipt dispatch failed', {
              providerMessageId: receipt.providerMessageId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
        for (const event of whatsappInboundAdapter.normalizeTemplateEvents(entry)) {
          void commerceInboundService.handleTemplateEvent(event).catch((error: unknown) => {
            Sentry.captureException(error);
            logger.error('commerce webhook: template event dispatch failed', {
              name: event.name,
              language: event.language,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
      }
    } catch (error) {
      this.handleError(error, res, 'MetaWebhookController.receive');
    }
  }
}

export const metaWebhookController = new MetaWebhookController();
