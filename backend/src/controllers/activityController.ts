import type { Request, Response } from 'express';
import { z } from 'zod';
import { BaseController } from './baseController.js';
import { auditReader } from '../control-plane/audit/auditReader.js';
import { parse } from '../utils/validate.js';

const querySchema = z.object({
  cursor: z.string().min(1).nullable().default(null),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

class ActivityController extends BaseController {
  async list(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.userId;
      if (userId === undefined) {
        throw new Error('list() requires requireAuth middleware');
      }
      const { cursor, limit } = parse(querySchema, req.query);
      const result = await auditReader.listForUser(userId, cursor, limit);
      this.handleSuccess(res, result, 200);
    } catch (error) {
      this.handleError(error, res, 'ActivityController.list');
    }
  }
}

export const activityController = new ActivityController();
