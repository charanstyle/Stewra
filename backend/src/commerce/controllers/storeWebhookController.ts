import type { Request, Response } from 'express';
import type { CommerceStore } from '@stewra/shared-types';
import { BaseController } from '../../controllers/baseController.js';
import { buildStoreProvider } from '../services/stores/index.js';
import { storeSubscriptionService } from '../services/storeSubscriptionService.js';

/**
 * The App Store and Google Play server notifications — mounted on a raw-body router BEFORE
 * express.json, same as /webhooks/meta and /webhooks/payments.
 *
 * Two stores, two routes, one shape. Which is not to say they authenticate alike, and this
 * controller is careful to know nothing about how either does it: **Apple signs the body** (the
 * whole proof is in the bytes) while **Google signs nothing at all** — a Pub/Sub push is ordinary
 * JSON whose entire claim to be from Google is the OIDC token in the Authorization header. Both
 * inputs are handed to the port, which is the only thing here that understands either.
 *
 * The raw-body guard is not defensive noise. If this router is ever remounted after the global
 * `express.json()`, `req.body` becomes a parsed object, Apple's signature would be checked against
 * a re-serialization, and every delivery would fail — loudly, and for a reason the message names,
 * rather than by silently rejecting real notifications.
 *
 * **Work first, ACK second — the opposite of `/webhooks/payments`, on purpose.** The payments
 * webhook ACKs before applying because a lost charge event can be reconciled from the provider
 * later. There is no such backstop here: entitlement state exists nowhere but in these deliveries,
 * and an ACKed-then-failed notification is an org that quietly keeps (or loses) access with nothing
 * left to replay. So a failure returns non-2xx and the store retries — Apple for about a day,
 * Pub/Sub for longer — which is a window in which an operator can fix the cause. The replay guard
 * in `applyNotification` is what makes those retries free.
 */
class StoreWebhookController extends BaseController {
  /** POST /webhooks/stores/apple */
  async receiveApple(req: Request, res: Response): Promise<void> {
    await this.receive('apple', req, res);
  }

  /** POST /webhooks/stores/google */
  async receiveGoogle(req: Request, res: Response): Promise<void> {
    await this.receive('google', req, res);
  }

  private async receive(store: CommerceStore, req: Request, res: Response): Promise<void> {
    try {
      if (!Buffer.isBuffer(req.body)) {
        throw new Error(
          `${store} store webhook: raw body unavailable — the webhook router must be mounted before express.json()`,
        );
      }
      const provider = buildStoreProvider(store);
      const notification = await provider.verifyNotification(
        req.body,
        req.get('authorization') ?? null,
      );
      const outcome = await storeSubscriptionService.applyNotification(store, notification);
      // Neither store reads the body; the outcome is here for whoever is holding a terminal during
      // store setup, when "it returned 200" and "it did something" are very different answers.
      res.status(200).json({ outcome });
    } catch (error) {
      this.handleError(error, res, `StoreWebhookController.receive.${store}`);
    }
  }
}

export const storeWebhookController = new StoreWebhookController();
