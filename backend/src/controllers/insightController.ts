import type { Request, Response } from 'express';
import { z } from 'zod';
import type { GenerateInsightResponse, InsightEngagementResponse } from '@stewra/shared-types';
import { BaseController } from './baseController.js';
import { insightService } from '../services/insightService.js';
import { parse } from '../utils/validate.js';

const generateSchema = z.object({
  kind: z.enum(['calendar', 'gmail', 'money', 'memory']),
  purpose: z.string().min(1).max(200).optional(),
});

// Path param for the engagement endpoints — the insight the impression/dismissal attaches to.
const engagementParamsSchema = z.object({
  insightId: z.string().uuid(),
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
      const { insight, insightId } = await insightService.generateAndRecord(
        userId,
        kind,
        purpose ?? DEFAULT_PURPOSE,
      );
      const body: GenerateInsightResponse = { insight, insightId };
      this.handleSuccess(res, body, 200);
    } catch (error) {
      this.handleError(error, res, 'InsightController.generate');
    }
  }

  /** POST /insights/:insightId/seen — record that an insight was surfaced (passive impression). */
  async markSeen(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.userId;
      if (userId === undefined) {
        throw new Error('markSeen() requires requireAuth middleware');
      }
      const { insightId } = parse(engagementParamsSchema, req.params);
      const body: InsightEngagementResponse = await insightService.markSeen(userId, insightId);
      this.handleSuccess(res, body, 200);
    } catch (error) {
      this.handleError(error, res, 'InsightController.markSeen');
    }
  }

  /** POST /insights/:insightId/dismissed — record the user dismissing an insight without rating it. */
  async markDismissed(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.userId;
      if (userId === undefined) {
        throw new Error('markDismissed() requires requireAuth middleware');
      }
      const { insightId } = parse(engagementParamsSchema, req.params);
      const body: InsightEngagementResponse = await insightService.markDismissed(userId, insightId);
      this.handleSuccess(res, body, 200);
    } catch (error) {
      this.handleError(error, res, 'InsightController.markDismissed');
    }
  }
}

export const insightController = new InsightController();
