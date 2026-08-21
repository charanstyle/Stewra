import type { Request, Response } from 'express';
import { z } from 'zod';
import type {
  CreateCommerceSegmentResponse,
  DeleteCommerceSegmentResponse,
  GetCommerceSegmentResponse,
  ListCommerceSegmentsResponse,
  ListSegmentMembersResponse,
  PreviewSegmentResponse,
  UpdateCommerceSegmentResponse,
} from '@stewra/shared-types';
import { BaseController } from '../../controllers/baseController.js';
import { audienceService } from '../services/audienceService.js';
import { orgContext } from '../../tenancy/middleware/requireOrgMember.js';
import { segmentDefinitionSchema } from '../services/segmentQuery.js';
import { parse } from '../../utils/validate.js';

const segmentParamsSchema = z.object({ segmentId: z.string().uuid() });

/**
 * The definition is validated by the SAME schema the compiler validates stored rows against.
 *
 * One schema, not two. A request-shaped validator that drifted from the storage-shaped one would let
 * a rule through the door that the compiler then refuses to evaluate — and the place that failure
 * would surface is the enqueue pass of a broadcast, long after the person who wrote the rule has gone.
 */
const writeSegmentSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2048).nullable().optional(),
  definition: segmentDefinitionSchema,
});

const previewSchema = z.object({
  definition: segmentDefinitionSchema,
  sampleLimit: z.coerce.number().int().min(1).max(100).optional(),
});

const listMembersSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  // `z.coerce.boolean()` would turn the string "false" into true, since a non-empty string is truthy
  // in JavaScript — and the direction that error fails in is showing contacts a broadcast will not
  // reach as though it will. The comparison is explicit for that reason.
  sendableOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

/**
 * Segments: saved audience rules, and what they resolve to right now.
 *
 * Preview takes a definition in the body rather than a saved id, because the question "how many
 * people is this?" is asked while the rule is still being written. Everything else here takes an id,
 * and re-resolves the rule on every read — a segment never hands back a stored member list.
 */
class SegmentsController extends BaseController {
  private userId(req: Request): string {
    const userId = req.userId;
    if (userId === undefined) throw new Error('requireAuth middleware missing');
    return userId;
  }

  /** GET /orgs/:orgId/segments */
  async list(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const segments = await audienceService.listSegments(orgId);
      const body: ListCommerceSegmentsResponse = { segments };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'SegmentsController.list');
    }
  }

  /** GET /orgs/:orgId/segments/:segmentId */
  async get(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const { segmentId } = parse(segmentParamsSchema, req.params);
      const segment = await audienceService.getSegment(orgId, segmentId);
      const body: GetCommerceSegmentResponse = { segment };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'SegmentsController.get');
    }
  }

  /** POST /orgs/:orgId/segments */
  async create(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const input = parse(writeSegmentSchema, req.body);
      const segment = await audienceService.createSegment({
        orgId,
        name: input.name,
        description: input.description ?? null,
        definition: input.definition,
        createdByUserId: this.userId(req),
      });
      const body: CreateCommerceSegmentResponse = { segment };
      this.handleSuccess(res, body, 201);
    } catch (error) {
      this.handleError(error, res, 'SegmentsController.create');
    }
  }

  /** PUT /orgs/:orgId/segments/:segmentId */
  async update(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const { segmentId } = parse(segmentParamsSchema, req.params);
      const input = parse(writeSegmentSchema, req.body);
      const segment = await audienceService.updateSegment({
        orgId,
        segmentId,
        name: input.name,
        description: input.description ?? null,
        definition: input.definition,
      });
      const body: UpdateCommerceSegmentResponse = { segment };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'SegmentsController.update');
    }
  }

  /** DELETE /orgs/:orgId/segments/:segmentId */
  async remove(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const { segmentId } = parse(segmentParamsSchema, req.params);
      const deleted = await audienceService.deleteSegment(orgId, segmentId);
      const body: DeleteCommerceSegmentResponse = { deleted };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'SegmentsController.remove');
    }
  }

  /** POST /orgs/:orgId/segments/preview */
  async preview(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const input = parse(previewSchema, req.body);
      const preview = await audienceService.previewSegment(
        orgId,
        input.definition,
        input.sampleLimit ?? 20,
      );
      const body: PreviewSegmentResponse = { preview };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'SegmentsController.preview');
    }
  }

  /** GET /orgs/:orgId/segments/:segmentId/members */
  async listMembers(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const { segmentId } = parse(segmentParamsSchema, req.params);
      const query = parse(listMembersSchema, req.query);
      const members = await audienceService.listSegmentMembers({
        orgId,
        segmentId,
        limit: query.limit ?? 100,
        offset: query.offset ?? 0,
        sendableOnly: query.sendableOnly,
      });
      const body: ListSegmentMembersResponse = { members };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'SegmentsController.listMembers');
    }
  }
}

export const segmentsController = new SegmentsController();
