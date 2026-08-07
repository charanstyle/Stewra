import type { Request, Response } from 'express';
import { z } from 'zod';
import type {
  CancelBroadcastResponse,
  CreateBroadcastResponse,
  GetBroadcastResponse,
  ListBroadcastRecipientsResponse,
  ListBroadcastsResponse,
  PreviewBroadcastResponse,
  ResumeBroadcastResponse,
} from '@stewra/shared-types';
import { BROADCAST_RECIPIENT_STATUSES } from '@stewra/shared-types';
import { BaseController } from '../../controllers/baseController.js';
import { broadcastService } from '../services/broadcastService.js';
import { orgContext } from '../middleware/requireOrgMember.js';
import { parse } from '../../utils/validate.js';

const broadcastParamsSchema = z.object({ broadcastId: z.string().uuid() });

const createBroadcastSchema = z.object({
  name: z.string().min(1).max(200),
  channelAccountId: z.string().uuid(),
  segmentId: z.string().uuid(),
  templateId: z.string().uuid(),
  // Empty variable values are refused here rather than at Meta: a template parameter of "" is
  // rejected per recipient, mid-campaign, which is the failure shape this whole surface avoids.
  variables: z.array(z.string().min(1).max(1024)).max(20),
  // Required with no default — "send now" is a timestamp said out loud, never an absence.
  scheduledFor: z.string().datetime({ offset: true }),
});

const previewSchema = z.object({
  segmentId: z.string().uuid(),
  templateId: z.string().uuid(),
});

const listRecipientsSchema = z.object({
  status: z.enum(BROADCAST_RECIPIENT_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

/** How many broadcasts one listing returns. Campaigns are weekly objects; 200 is years of them. */
const LIST_LIMIT = 200;

/**
 * Scheduled broadcasts — the API face of the dispatch/send job chain.
 *
 * Nothing here sends anything. Create writes a row and enqueues a dispatch job for `scheduledFor`;
 * everything after that happens on the queue, which is why cancel and resume are status transitions
 * rather than actions — the workers read the status at every batch boundary and obey it.
 */
class BroadcastsController extends BaseController {
  private userId(req: Request): string {
    const userId = req.userId;
    if (userId === undefined) throw new Error('requireAuth middleware missing');
    return userId;
  }

  /** GET /orgs/:orgId/broadcasts */
  async list(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const broadcasts = await broadcastService.list(orgId, LIST_LIMIT);
      const body: ListBroadcastsResponse = { broadcasts };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'BroadcastsController.list');
    }
  }

  /** POST /orgs/:orgId/broadcasts */
  async create(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const input = parse(createBroadcastSchema, req.body);
      const broadcast = await broadcastService.create({
        orgId,
        createdByUserId: this.userId(req),
        name: input.name,
        channelAccountId: input.channelAccountId,
        segmentId: input.segmentId,
        templateId: input.templateId,
        variables: input.variables,
        scheduledFor: new Date(input.scheduledFor),
      });
      const body: CreateBroadcastResponse = { broadcast };
      this.handleSuccess(res, body, 201);
    } catch (error) {
      this.handleError(error, res, 'BroadcastsController.create');
    }
  }

  /** POST /orgs/:orgId/broadcasts/preview */
  async preview(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const input = parse(previewSchema, req.body);
      const body: PreviewBroadcastResponse = await broadcastService.preview({
        orgId,
        segmentId: input.segmentId,
        templateId: input.templateId,
      });
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'BroadcastsController.preview');
    }
  }

  /** GET /orgs/:orgId/broadcasts/:broadcastId */
  async get(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const { broadcastId } = parse(broadcastParamsSchema, req.params);
      const broadcast = await broadcastService.get(orgId, broadcastId);
      const body: GetBroadcastResponse = { broadcast };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'BroadcastsController.get');
    }
  }

  /** POST /orgs/:orgId/broadcasts/:broadcastId/cancel */
  async cancel(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const { broadcastId } = parse(broadcastParamsSchema, req.params);
      const broadcast = await broadcastService.cancel(orgId, broadcastId);
      const body: CancelBroadcastResponse = { broadcast };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'BroadcastsController.cancel');
    }
  }

  /** POST /orgs/:orgId/broadcasts/:broadcastId/resume */
  async resume(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const { broadcastId } = parse(broadcastParamsSchema, req.params);
      const broadcast = await broadcastService.resume(orgId, broadcastId);
      const body: ResumeBroadcastResponse = { broadcast };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'BroadcastsController.resume');
    }
  }

  /** GET /orgs/:orgId/broadcasts/:broadcastId/recipients */
  async listRecipients(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const { broadcastId } = parse(broadcastParamsSchema, req.params);
      const query = parse(listRecipientsSchema, req.query);
      const recipients = await broadcastService.listRecipients({
        orgId,
        broadcastId,
        status: query.status,
        limit: query.limit,
        offset: query.offset,
      });
      const body: ListBroadcastRecipientsResponse = { recipients };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'BroadcastsController.listRecipients');
    }
  }
}

export const broadcastsController = new BroadcastsController();
