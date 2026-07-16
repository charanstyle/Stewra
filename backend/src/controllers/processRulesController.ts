import type { Request, Response } from 'express';
import { z } from 'zod';
import type {
  CreateProcessRuleResponse,
  DeleteProcessRuleResponse,
  ListProcessRulesResponse,
  UpdateProcessRuleResponse,
} from '@stewra/shared-types';
import { BaseController } from './baseController.js';
import { processMemoryService } from '../services/processMemoryService.js';
import { parse } from '../utils/validate.js';

// Controlled vocabularies mirror the shared-types unions — the API only ever accepts a known axis.
const domainSchema = z.enum(['email', 'advice', 'inbox', 'calendar']);
const dimensionSchema = z.enum([
  'tone',
  'length',
  'structure',
  'salutation',
  'signoff',
  'recipients',
  'proofreading',
  'timing',
  'do_not',
]);
const statusSchema = z.enum(['proposed', 'active', 'muted']);

const listQuerySchema = z.object({
  domain: domainSchema.optional(),
  status: statusSchema.optional(),
  search: z.string().trim().max(200).optional(),
});

// A user-stated rule. `subjectRole` is only meaningful for the `recipients` dimension; a concrete
// contact identity is never accepted here — the server only ever stores a role (Phase F adds the vault
// path for identities it derives itself).
const createSchema = z.object({
  domain: domainSchema,
  dimension: dimensionSchema,
  rule: z.string().trim().min(1).max(2000),
  subjectRole: z.string().trim().min(1).max(64).nullable().optional(),
});

const idParamSchema = z.object({
  id: z.string().uuid(),
});

// At least one field must be present so a PATCH always expresses an actual edit. `status` lets the user
// confirm a proposal (`active`), mute it, or re-propose; `visible` toggles recall eligibility.
const updateSchema = z
  .object({
    rule: z.string().trim().min(1).max(2000).optional(),
    status: statusSchema.optional(),
    visible: z.boolean().optional(),
  })
  .refine((v) => v.rule !== undefined || v.status !== undefined || v.visible !== undefined, {
    message: 'Provide at least one field to update',
  });

class ProcessRulesController extends BaseController {
  /** GET /process-rules — the user's process/style rules, optional ?domain=/?status=/?search= filters. */
  async list(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.userId;
      if (userId === undefined) {
        throw new Error('list() requires requireAuth middleware');
      }
      const { domain, status, search } = parse(listQuerySchema, req.query);
      const rules = await processMemoryService.listRules(userId, {
        ...(domain !== undefined ? { domain } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(search !== undefined ? { search } : {}),
      });
      const body: ListProcessRulesResponse = { rules };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'ProcessRulesController.list');
    }
  }

  /** POST /process-rules — the user states a rule directly (created `active`). */
  async create(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.userId;
      if (userId === undefined) {
        throw new Error('create() requires requireAuth middleware');
      }
      const input = parse(createSchema, req.body);
      const rule = await processMemoryService.createStatedRule(userId, {
        domain: input.domain,
        dimension: input.dimension,
        rule: input.rule,
        subjectRole: input.subjectRole ?? null,
      });
      const body: CreateProcessRuleResponse = { rule };
      this.handleSuccess(res, body, 201);
    } catch (error) {
      this.handleError(error, res, 'ProcessRulesController.create');
    }
  }

  /** PATCH /process-rules/:id — revise text, confirm/mute via status, or toggle recall visibility. */
  async update(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.userId;
      if (userId === undefined) {
        throw new Error('update() requires requireAuth middleware');
      }
      const { id } = parse(idParamSchema, req.params);
      const patch = parse(updateSchema, req.body);
      const rule = await processMemoryService.updateRule(userId, id, {
        ...(patch.rule !== undefined ? { rule: patch.rule } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.visible !== undefined ? { visible: patch.visible } : {}),
      });
      const body: UpdateProcessRuleResponse = { rule };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'ProcessRulesController.update');
    }
  }

  /** DELETE /process-rules/:id — really forget one rule (no soft-delete). */
  async remove(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.userId;
      if (userId === undefined) {
        throw new Error('remove() requires requireAuth middleware');
      }
      const { id } = parse(idParamSchema, req.params);
      await processMemoryService.deleteRule(userId, id);
      const body: DeleteProcessRuleResponse = { id };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'ProcessRulesController.remove');
    }
  }
}

export const processRulesController = new ProcessRulesController();
