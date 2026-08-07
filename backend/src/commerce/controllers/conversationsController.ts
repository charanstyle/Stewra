import type { Request, Response } from 'express';
import { z } from 'zod';
import type {
  CreateCommerceMessageResponse,
  ListCommerceConversationsResponse,
  ListCommerceMessagesResponse,
} from '@stewra/shared-types';
import { BaseController } from '../../controllers/baseController.js';
import { commerceInboxService } from '../services/commerceInboxService.js';
import { orgContext } from '../middleware/requireOrgMember.js';
import { parse } from '../../utils/validate.js';

const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).optional(),
});
const conversationParamsSchema = z.object({ conversationId: z.string().uuid() });
const replySchema = z.object({ body: z.string().min(1).max(4096) });

/** The shared inbox surface. Every method reads its tenant from `requireOrgMember`, never the body. */
class ConversationsController extends BaseController {
  private userId(req: Request): string {
    const userId = req.userId;
    if (userId === undefined) throw new Error('requireAuth middleware missing');
    return userId;
  }

  /** GET /orgs/:orgId/conversations */
  async list(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const { limit, cursor } = parse(pageSchema, req.query);
      const result = await commerceInboxService.listConversations({ orgId, limit, cursor });
      const body: ListCommerceConversationsResponse = result;
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'ConversationsController.list');
    }
  }

  /** GET /orgs/:orgId/conversations/:conversationId/messages */
  async listMessages(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const { conversationId } = parse(conversationParamsSchema, req.params);
      const { limit, cursor } = parse(pageSchema, req.query);
      const result = await commerceInboxService.listMessages({
        orgId,
        conversationId,
        limit,
        cursor,
      });
      const body: ListCommerceMessagesResponse = result;
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'ConversationsController.listMessages');
    }
  }

  /** POST /orgs/:orgId/conversations/:conversationId/messages */
  async reply(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const { conversationId } = parse(conversationParamsSchema, req.params);
      const { body: text } = parse(replySchema, req.body);
      const message = await commerceInboxService.sendReply({
        orgId,
        conversationId,
        body: text,
        sentByUserId: this.userId(req),
      });
      const body: CreateCommerceMessageResponse = { message };
      this.handleSuccess(res, body, 201);
    } catch (error) {
      this.handleError(error, res, 'ConversationsController.reply');
    }
  }
}

export const conversationsController = new ConversationsController();
