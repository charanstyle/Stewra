import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  PASSWORD_RESET_CODE_LENGTH,
  PASSWORD_RESET_MIN_PASSWORD_LENGTH,
} from '@stewra/shared-types';
import type {
  ConfirmPasswordResetResponse,
  RequestPasswordResetResponse,
} from '@stewra/shared-types';
import { BaseController } from './baseController.js';
import { authService } from '../services/authService.js';
import { passwordResetService } from '../services/passwordResetService.js';
import { parse } from '../utils/validate.js';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  displayName: z.string().min(1).max(255),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

const requestPasswordResetSchema = z.object({
  email: z.string().email(),
});

const confirmPasswordResetSchema = z.object({
  email: z.string().email(),
  code: z
    .string()
    .trim()
    .regex(new RegExp(`^\\d{${PASSWORD_RESET_CODE_LENGTH}}$`), 'Enter the 6-digit code from your email.'),
  newPassword: z
    .string()
    .min(
      PASSWORD_RESET_MIN_PASSWORD_LENGTH,
      `Password must be at least ${PASSWORD_RESET_MIN_PASSWORD_LENGTH} characters`,
    ),
});

class AuthController extends BaseController {
  async register(req: Request, res: Response): Promise<void> {
    try {
      const body = parse(registerSchema, req.body);
      const result = await authService.register(body);
      this.handleSuccess(res, result, 201);
    } catch (error) {
      this.handleError(error, res, 'AuthController.register');
    }
  }

  async login(req: Request, res: Response): Promise<void> {
    try {
      const body = parse(loginSchema, req.body);
      const result = await authService.login(body);
      this.handleSuccess(res, result, 200);
    } catch (error) {
      this.handleError(error, res, 'AuthController.login');
    }
  }

  async refresh(req: Request, res: Response): Promise<void> {
    try {
      const body = parse(refreshSchema, req.body);
      const result = await authService.refresh(body.refreshToken);
      this.handleSuccess(res, result, 200);
    } catch (error) {
      this.handleError(error, res, 'AuthController.refresh');
    }
  }

  async me(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.userId;
      if (userId === undefined) {
        throw new Error('me() requires requireAuth middleware');
      }
      const user = await authService.getStatus(userId);
      this.handleSuccess(res, { user }, 200);
    } catch (error) {
      this.handleError(error, res, 'AuthController.me');
    }
  }

  /**
   * Start a password reset: email a code IF the address is registered. Always 200 with a generic ack,
   * regardless of whether the email exists, so the endpoint can't enumerate accounts.
   */
  async requestPasswordReset(req: Request, res: Response): Promise<void> {
    try {
      const body = parse(requestPasswordResetSchema, req.body);
      await passwordResetService.request(body.email);
      const result: RequestPasswordResetResponse = { ok: true };
      this.handleSuccess(res, result, 200);
    } catch (error) {
      this.handleError(error, res, 'AuthController.requestPasswordReset');
    }
  }

  /** Complete a password reset: verify the emailed code and set the new password. */
  async confirmPasswordReset(req: Request, res: Response): Promise<void> {
    try {
      const body = parse(confirmPasswordResetSchema, req.body);
      await passwordResetService.confirm(body.email, body.code, body.newPassword);
      const result: ConfirmPasswordResetResponse = { ok: true };
      this.handleSuccess(res, result, 200);
    } catch (error) {
      this.handleError(error, res, 'AuthController.confirmPasswordReset');
    }
  }
}

export const authController = new AuthController();
