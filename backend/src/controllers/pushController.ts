import type { Request, Response } from 'express';
import { z } from 'zod';
import type { RegisterPushTokenResponse } from '@stewra/shared-types';
import { BaseController } from './baseController.js';
import { pushTokenService } from '../services/pushTokenService.js';
import { parse } from '../utils/validate.js';

// A device is exactly one platform and supplies its Expo push token. Kept minimal on purpose — this
// endpoint only records where a user's device can be reached; it grants no capability.
const registerPushTokenSchema = z.object({
  platform: z.enum(['ios', 'android']),
  expoPushToken: z.string().min(1),
});

/** General push-notification REST surface (behind requireAuth + requireEmailVerification). */
class PushController extends BaseController {
  private userId(req: Request): string {
    const userId = req.userId;
    if (userId === undefined) throw new Error('requireAuth middleware missing');
    return userId;
  }

  /** PUT /push/token — register/refresh this device's Expo push token. */
  async registerToken(req: Request, res: Response): Promise<void> {
    try {
      const parsed = parse(registerPushTokenSchema, req.body);
      await pushTokenService.register(this.userId(req), parsed);
      const body: RegisterPushTokenResponse = { registered: true };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'PushController.registerToken');
    }
  }
}

export const pushController = new PushController();
