import type { Request, Response } from 'express';
import { z } from 'zod';
import * as Sentry from '@sentry/node';
import type { ChannelIdentity, ChannelLinkChallenge } from '@stewra/shared-types';
import { BaseController } from './baseController';
import { whatsappService, type InboundWhatsappMessage } from '../services/whatsappService';
import { config } from '../config/unifiedConfig';
import { ServiceUnavailableError } from '../utils/errors';
import { logger } from '../utils/logger';

/**
 * Meta's inbound envelope. Everything is optional-by-shape because the SAME subscription also delivers
 * delivery/read receipts (`statuses[]`) and system notifications — a payload with no `messages[]` is
 * normal traffic, not an error. Arrays are batched: Meta may pack several messages into one POST, so
 * never index `[0]`.
 */
const webhookSchema = z.object({
  object: z.string(),
  entry: z
    .array(
      z.object({
        changes: z
          .array(
            z.object({
              value: z.object({
                messages: z
                  .array(
                    z.object({
                      id: z.string(),
                      from: z.string(),
                      type: z.string(),
                      text: z.object({ body: z.string() }).optional(),
                    }),
                  )
                  .optional(),
              }),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

/** Meta's GET handshake when you first register the callback URL. */
const verifySchema = z.object({
  'hub.mode': z.string(),
  'hub.verify_token': z.string(),
  'hub.challenge': z.string(),
});

/**
 * The WhatsApp channel surface: Meta's webhook (unauthenticated, HMAC-verified) plus the authenticated
 * link/unlink endpoints the app calls.
 */
class WhatsappController extends BaseController {
  private userId(req: Request): string {
    const userId = req.userId;
    if (userId === undefined) throw new Error('requireAuth middleware missing');
    return userId;
  }

  private assertEnabled(): void {
    if (!config.whatsapp.enabled) {
      throw new ServiceUnavailableError('WhatsApp is currently unavailable');
    }
  }

  /**
   * GET /webhooks/whatsapp — Meta's subscription handshake. Echo `hub.challenge` back as PLAIN TEXT
   * (not JSON, and not wrapped in our envelope) or Meta rejects the endpoint. Constant-time-ish compare
   * on the token is unnecessary here: it's a one-shot setup step, and the token is not a message key.
   */
  verify(req: Request, res: Response): void {
    try {
      this.assertEnabled();
      const query = verifySchema.safeParse(req.query);
      if (
        !query.success ||
        query.data['hub.mode'] !== 'subscribe' ||
        query.data['hub.verify_token'] !== config.whatsapp.verifyToken
      ) {
        logger.warn('whatsapp webhook: verification handshake rejected');
        res.sendStatus(403);
        return;
      }
      res.status(200).type('text/plain').send(query.data['hub.challenge']);
    } catch (error) {
      this.handleError(error, res, 'WhatsappController.verify');
    }
  }

  /**
   * POST /webhooks/whatsapp — inbound messages. Runs behind the HMAC middleware, so the request is
   * already proven to come from Meta.
   *
   * ACK IMMEDIATELY, THEN WORK. Meta retries for up to 7 days until it sees a 200, and an LLM turn takes
   * seconds — so holding the response open would earn us duplicate deliveries of a message we're already
   * answering. We 200 first and process off the request path (each message is separately deduped on its
   * provider id, which is the real guarantee).
   */
  receive(req: Request, res: Response): void {
    try {
      this.assertEnabled();

      // The signature middleware needs raw bytes, so the body is still a Buffer here.
      const parsed = webhookSchema.safeParse(JSON.parse(req.body.toString('utf8')));
      if (!parsed.success) {
        // Malformed, but authentically Meta's — 200 anyway, or it retries this forever.
        logger.warn('whatsapp webhook: unrecognized payload shape; acking to stop retries');
        res.sendStatus(200);
        return;
      }

      res.sendStatus(200);

      for (const message of this.extractMessages(parsed.data)) {
        void whatsappService.handleInbound(message).catch((error: unknown) => {
          Sentry.captureException(error);
          logger.error('whatsapp: inbound dispatch failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    } catch (error) {
      this.handleError(error, res, 'WhatsappController.receive');
    }
  }

  /**
   * Flatten Meta's batched envelope into the messages we can act on. Non-text types (image, audio,
   * sticker, …) come through with `text: null` so the service can tell the user we only read text,
   * rather than dropping their message into a void.
   */
  private extractMessages(payload: z.infer<typeof webhookSchema>): InboundWhatsappMessage[] {
    const out: InboundWhatsappMessage[] = [];
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        // Absent `messages` = a status/receipt callback on the same subscription. Ignore it.
        for (const message of change.value.messages ?? []) {
          out.push({
            id: message.id,
            from: message.from,
            text: message.type === 'text' ? message.text?.body ?? null : null,
          });
        }
      }
    }
    return out;
  }

  /** POST /channels/whatsapp/link — mint a single-use code + wa.me deep link for the current user. */
  async startLink(req: Request, res: Response): Promise<void> {
    try {
      this.assertEnabled();
      const challenge: ChannelLinkChallenge = await whatsappService.createLinkChallenge(
        this.userId(req),
      );
      this.handleSuccess(res, challenge, 201);
    } catch (error) {
      this.handleError(error, res, 'WhatsappController.startLink');
    }
  }

  /** GET /channels/whatsapp — the user's current link, or null. */
  async status(req: Request, res: Response): Promise<void> {
    try {
      this.assertEnabled();
      const identity: ChannelIdentity | null = await whatsappService.getIdentity(this.userId(req));
      this.handleSuccess(res, { identity });
    } catch (error) {
      this.handleError(error, res, 'WhatsappController.status');
    }
  }

  /** DELETE /channels/whatsapp — revoke the link. */
  async unlink(req: Request, res: Response): Promise<void> {
    try {
      this.assertEnabled();
      const removed = await whatsappService.unlink(this.userId(req));
      this.handleSuccess(res, { removed });
    } catch (error) {
      this.handleError(error, res, 'WhatsappController.unlink');
    }
  }
}

export const whatsappController = new WhatsappController();
