import type { Request, Response } from 'express';
import { z } from 'zod';
import type {
  DeleteMemoryResponse,
  ListMemoriesResponse,
  UpdateMemoryResponse,
} from '@stewra/shared-types';
import { BaseController } from './baseController.js';
import { memoryService } from '../services/memoryService.js';
import { parse } from '../utils/validate.js';

// Memory is scoped to a connected source kind (memory itself is never a scope of a memory).
const kindSchema = z.enum(['calendar', 'gmail', 'money']);

const listQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  kind: kindSchema.optional(),
});

const idParamSchema = z.object({
  id: z.string().uuid(),
});

// At least one field must be present, so a PATCH always expresses an actual edit. `guidance` may be
// explicitly null (clearing the note); `label` must stay a non-empty searchable name.
const updateSchema = z
  .object({
    label: z.string().trim().min(1).max(200).optional(),
    guidance: z.string().trim().max(2000).nullable().optional(),
    visible: z.boolean().optional(),
  })
  .refine(
    (v) => v.label !== undefined || v.guidance !== undefined || v.visible !== undefined,
    { message: 'Provide at least one field to update' },
  );

class MemoryController extends BaseController {
  /** GET /memory — the user's own learnings ("things I've learned about you"), optionally filtered. */
  async list(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.userId;
      if (userId === undefined) {
        throw new Error('list() requires requireAuth middleware');
      }
      const { search, kind } = parse(listQuerySchema, req.query);
      const memories = await memoryService.listMemories(userId, {
        ...(search !== undefined ? { search } : {}),
        ...(kind !== undefined ? { kind } : {}),
      });
      const body: ListMemoriesResponse = { memories };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'MemoryController.list');
    }
  }

  /** PATCH /memory/:id — rename the label, revise/clear guidance, or toggle recall visibility. */
  async update(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.userId;
      if (userId === undefined) {
        throw new Error('update() requires requireAuth middleware');
      }
      const { id } = parse(idParamSchema, req.params);
      const patch = parse(updateSchema, req.body);
      const memory = await memoryService.updateMemory(userId, id, {
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(patch.guidance !== undefined
          ? { guidance: patch.guidance !== null && patch.guidance.length > 0 ? patch.guidance : null }
          : {}),
        ...(patch.visible !== undefined ? { visible: patch.visible } : {}),
      });
      const body: UpdateMemoryResponse = { memory };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'MemoryController.update');
    }
  }

  /** DELETE /memory/:id — really forget one learning (no soft-delete). */
  async remove(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.userId;
      if (userId === undefined) {
        throw new Error('remove() requires requireAuth middleware');
      }
      const { id } = parse(idParamSchema, req.params);
      await memoryService.deleteMemory(userId, id);
      const body: DeleteMemoryResponse = { id };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'MemoryController.remove');
    }
  }
}

export const memoryController = new MemoryController();
