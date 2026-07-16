import type { Request, Response } from 'express';
import { z } from 'zod';
import type {
  ListCallHistoryResponse,
  RegisterCallPushTokenResponse,
  TurnCredentialsResponse,
} from '@stewra/shared-types';
import { BaseController } from './baseController.js';
import { callService } from '../services/callService.js';
import { turnCredentialsService } from '../services/turnCredentialsService.js';
import { config } from '../config/unifiedConfig.js';
import { ServiceUnavailableError } from '../utils/errors.js';
import { parse } from '../utils/validate.js';

// A device is exactly one platform; the required token is tied to it (discriminated on `platform`).
const pushTokenSchema = z.discriminatedUnion('platform', [
  z.object({ platform: z.literal('ios'), voipToken: z.string().min(1) }),
  z.object({ platform: z.literal('android'), fcmToken: z.string().min(1) }),
]);

/** Calls REST surface (all routes behind requireAuth + requireEmailVerification). */
class CallsController extends BaseController {
  private userId(req: Request): string {
    const userId = req.userId;
    if (userId === undefined) throw new Error('requireAuth middleware missing');
    return userId;
  }

  /** GET /calls/turn-credentials — mint short-lived ICE server credentials (kill-switched). */
  async turnCredentials(req: Request, res: Response): Promise<void> {
    try {
      const userId = this.userId(req);
      if (!config.calls.enabled) {
        throw new ServiceUnavailableError('Calling is currently unavailable');
      }
      const body: TurnCredentialsResponse = turnCredentialsService.generate(userId);
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'CallsController.turnCredentials');
    }
  }

  /** PUT /calls/push-token — register/refresh this device's background-ring token. */
  async registerPushToken(req: Request, res: Response): Promise<void> {
    try {
      const parsed = parse(pushTokenSchema, req.body);
      await callService.registerPushToken(this.userId(req), parsed);
      const body: RegisterCallPushTokenResponse = { registered: true };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'CallsController.registerPushToken');
    }
  }

  /** GET /calls/history — the caller's recent calls across their conversations, newest-first. */
  async history(req: Request, res: Response): Promise<void> {
    try {
      const calls = await callService.history(this.userId(req));
      const body: ListCallHistoryResponse = { calls };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'CallsController.history');
    }
  }
}

export const callsController = new CallsController();
