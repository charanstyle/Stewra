import type { Request, Response } from 'express';
import { z } from 'zod';
import type { GenerateInsightResponse } from '@stewra/shared-types';
import { BaseController } from './baseController';
import { insightService } from '../services/insightService';
import { parse } from '../utils/validate';

const generateSchema = z.object({
  kind: z.enum(['calendar', 'gmail', 'money', 'memory']),
  purpose: z.string().min(1).max(200).optional(),
});

// The audit label when the user doesn't supply a purpose — plain language, no jargon.
const DEFAULT_PURPOSE = 'an at-a-glance look at what needs your attention';

class InsightController extends BaseController {
  /** POST /insights — produce one advice-only insight over a connected resource. */
  async generate(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.userId;
      if (userId === undefined) {
        throw new Error('generate() requires requireAuth middleware');
      }
      const { kind, purpose } = parse(generateSchema, req.body);
      const insight = await insightService.generateAndRecord(
        userId,
        kind,
        purpose ?? DEFAULT_PURPOSE,
      );
      const body: GenerateInsightResponse = { insight };
      this.handleSuccess(res, body, 200);
    } catch (error) {
      this.handleError(error, res, 'InsightController.generate');
    }
  }
}

export const insightController = new InsightController();
