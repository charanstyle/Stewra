import type { Request, Response } from 'express';
import { z } from 'zod';
import * as Sentry from '@sentry/node';
import type { InboundSms, ListInboundSmsResponse } from '@stewra/shared-types';
import { BaseController } from './baseController.js';
import { config } from '../config/unifiedConfig.js';
import { telnyxInboundSmsService } from '../services/telnyxInboundSmsService.js';
import { ServiceUnavailableError, ValidationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/**
 * Telnyx's envelope. The same webhook URL also carries delivery reports (`message.sent`,
 * `message.finalized`), so anything but `message.received` is normal traffic to ack and drop.
 */
const eventSchema = z.object({
  data: z.object({
    event_type: z.string(),
    payload: z
      .object({
        id: z.string(),
        from: z.object({ phone_number: z.string() }),
        to: z.array(z.object({ phone_number: z.string() })).min(1),
        text: z.string().optional(),
        received_at: z.string().optional(),
      })
      .optional(),
  }),
});

const numberSchema = z.string().regex(/^\+[1-9]\d{6,14}$/);

class TelnyxController extends BaseController {
  private assertEnabled(): void {
    if (!config.telnyxInbound.enabled) {
      throw new ServiceUnavailableError('Telnyx inbound SMS is not enabled on this install');
    }
  }

  /** Signature already verified. Ack first, then record — Telnyx retries until it sees a 2xx. */
  receive(req: Request, res: Response): void {
    try {
      this.assertEnabled();
      const parsed = eventSchema.safeParse(JSON.parse(req.body.toString('utf8')));
      if (!parsed.success) {
        logger.warn('telnyx webhook: unrecognized payload shape; acking to stop retries');
        res.sendStatus(200);
        return;
      }
      res.sendStatus(200);

      const { event_type: eventType, payload } = parsed.data.data;
      if (eventType !== 'message.received' || payload === undefined || payload.text === undefined) return;
      const message: InboundSms = {
        from: payload.from.phone_number,
        to: payload.to[0]?.phone_number ?? '',
        text: payload.text,
        receivedAt: payload.received_at ?? new Date().toISOString(),
        providerMessageId: payload.id,
      };
      void telnyxInboundSmsService.record(message).catch((error: unknown) => {
        Sentry.captureException(error, { tags: { surface: 'telnyx_inbound' } });
        logger.error('telnyx: recording an inbound SMS failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } catch (error) {
      this.handleError(error, res, 'TelnyxController.receive');
    }
  }

  async list(req: Request, res: Response): Promise<void> {
    try {
      this.assertEnabled();
      const number = numberSchema.safeParse(req.params['number']);
      if (!number.success) throw new ValidationError('number must be E.164, e.g. +13125550100');
      const body: ListInboundSmsResponse = { messages: await telnyxInboundSmsService.list(number.data) };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'TelnyxController.list');
    }
  }
}

export const telnyxController = new TelnyxController();
