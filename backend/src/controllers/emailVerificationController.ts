import type { Request, Response } from 'express';
import { z } from 'zod';
import { EMAIL_VERIFICATION_CODE_LENGTH } from '@stewra/shared-types';
import type {
  ResendVerificationResponse,
  VerifyEmailResponse,
} from '@stewra/shared-types';
import { BaseController } from './baseController.js';
import { emailVerificationService } from '../services/emailVerificationService.js';
import { parse } from '../utils/validate.js';

// The code is exactly N digits — reject anything else before it reaches the service.
const verifySchema = z.object({
  code: z
    .string()
    .trim()
    .regex(new RegExp(`^\\d{${EMAIL_VERIFICATION_CODE_LENGTH}}$`), 'Enter the 6-digit code from your email.'),
});

class EmailVerificationController extends BaseController {
  /** Check a submitted code and, on success, return the now-verified user. */
  async verify(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.userId;
      if (userId === undefined) {
        throw new Error('verify() requires requireAuth middleware');
      }
      const body = parse(verifySchema, req.body);
      const user = await emailVerificationService.verify(userId, body.code);
      const result: VerifyEmailResponse = { user };
      this.handleSuccess(res, result, 200);
    } catch (error) {
      this.handleError(error, res, 'EmailVerificationController.verify');
    }
  }

  /** Re-send a fresh code, enforcing the per-user cooldown. */
  async resend(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.userId;
      if (userId === undefined) {
        throw new Error('resend() requires requireAuth middleware');
      }
      const expiresAt = await emailVerificationService.resend(userId);
      const result: ResendVerificationResponse = { expiresAt: expiresAt.toISOString() };
      this.handleSuccess(res, result, 200);
    } catch (error) {
      this.handleError(error, res, 'EmailVerificationController.resend');
    }
  }
}

export const emailVerificationController = new EmailVerificationController();
