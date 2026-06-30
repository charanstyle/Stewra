import type { Request, Response } from 'express';
import { z } from 'zod';
import { BaseController } from './baseController';
import { authService } from '../services/authService';
import { parse } from '../utils/validate';

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
}

export const authController = new AuthController();
