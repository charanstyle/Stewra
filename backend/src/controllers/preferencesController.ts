import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  GMAIL_LOOKBACK_MIN_DAYS,
  GMAIL_LOOKBACK_MAX_DAYS,
  type GetPreferencesResponse,
  type UpdatePreferencesResponse,
} from '@stewra/shared-types';
import { BaseController } from './baseController.js';
import { preferencesService } from '../services/preferencesService.js';
import { parse } from '../utils/validate.js';

// Every field optional (a partial update); the lookback is bounded to the shared contract limits.
const updateSchema = z.object({
  gmailLookbackDays: z.coerce
    .number()
    .int()
    .min(GMAIL_LOOKBACK_MIN_DAYS)
    .max(GMAIL_LOOKBACK_MAX_DAYS)
    .optional(),
  // Explicit opt-in for the Sent-mail style observer (a new data use) — a plain boolean toggle.
  learnFromSentMail: z.boolean().optional(),
  // Share read receipts in human chats (symmetric: off also hides others' receipts).
  readReceiptsEnabled: z.boolean().optional(),
});

class PreferencesController extends BaseController {
  /** GET /preferences — the user's fully-resolved settings (defaults filled in). */
  async get(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.userId;
      if (userId === undefined) {
        throw new Error('get() requires requireAuth middleware');
      }
      const preferences = await preferencesService.getForUser(userId);
      const body: GetPreferencesResponse = { preferences };
      this.handleSuccess(res, body, 200);
    } catch (error) {
      this.handleError(error, res, 'PreferencesController.get');
    }
  }

  /** PATCH /preferences — change a subset of settings (e.g. the Gmail lookback window). */
  async update(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.userId;
      if (userId === undefined) {
        throw new Error('update() requires requireAuth middleware');
      }
      const patch = parse(updateSchema, req.body);
      const preferences = await preferencesService.update(userId, patch);
      const body: UpdatePreferencesResponse = { preferences };
      this.handleSuccess(res, body, 200);
    } catch (error) {
      this.handleError(error, res, 'PreferencesController.update');
    }
  }
}

export const preferencesController = new PreferencesController();
