import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  SERVER_EVENTS,
  type AddParticipantsResponse,
  type ChatReadEvent,
  type CreateConversationResponse,
  type GetConversationResponse,
  type GetStewraConversationResponse,
  type LeaveConversationResponse,
  type ListConversationsResponse,
  type MarkReadResponse,
} from '@stewra/shared-types';
import { BaseController } from './baseController';
import { conversationService } from '../services/conversationService';
import { emitToConversation } from '../websocket/emitter';
import { parse } from '../utils/validate';

const createSchema = z.object({
  type: z.enum(['direct', 'group']),
  participantUserIds: z.array(z.string().uuid()).min(1).max(256),
  title: z.string().min(1).max(200).optional(),
});
const idParamsSchema = z.object({ id: z.string().uuid() });
const addParticipantsSchema = z.object({
  userIds: z.array(z.string().uuid()).min(1).max(256),
});
const markReadSchema = z.object({ upToMessageId: z.string().uuid() });

/** Conversations REST surface (all routes behind requireAuth + requireEmailVerification). */
class ConversationsController extends BaseController {
  private userId(req: Request): string {
    const userId = req.userId;
    if (userId === undefined) throw new Error('requireAuth middleware missing');
    return userId;
  }

  /** POST /conversations — create a direct or group conversation. */
  async create(req: Request, res: Response): Promise<void> {
    try {
      const { type, participantUserIds, title } = parse(createSchema, req.body);
      const conversation = await conversationService.create(
        this.userId(req),
        type,
        participantUserIds,
        title ?? null,
      );
      const body: CreateConversationResponse = { conversation };
      this.handleSuccess(res, body, 201);
    } catch (error) {
      this.handleError(error, res, 'ConversationsController.create');
    }
  }

  /** GET /conversations — the caller's conversation list. */
  async list(req: Request, res: Response): Promise<void> {
    try {
      const conversations = await conversationService.list(this.userId(req));
      const body: ListConversationsResponse = { conversations };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'ConversationsController.list');
    }
  }

  /** GET /conversations/stewra — the caller's singleton Stewra-AI conversation (provisions on first call). */
  async getStewra(req: Request, res: Response): Promise<void> {
    try {
      const conversation = await conversationService.getOrCreateStewra(this.userId(req));
      const body: GetStewraConversationResponse = { conversation };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'ConversationsController.getStewra');
    }
  }

  /** GET /conversations/:id — a single conversation summary. */
  async get(req: Request, res: Response): Promise<void> {
    try {
      const { id } = parse(idParamsSchema, req.params);
      const conversation = await conversationService.get(this.userId(req), id);
      const body: GetConversationResponse = { conversation };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'ConversationsController.get');
    }
  }

  /** POST /conversations/:id/participants — add members to a group (admin only). */
  async addParticipants(req: Request, res: Response): Promise<void> {
    try {
      const { id } = parse(idParamsSchema, req.params);
      const { userIds } = parse(addParticipantsSchema, req.body);
      const conversation = await conversationService.addParticipants(this.userId(req), id, userIds);
      const body: AddParticipantsResponse = { conversation };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'ConversationsController.addParticipants');
    }
  }

  /** POST /conversations/:id/leave — soft-leave a conversation. */
  async leave(req: Request, res: Response): Promise<void> {
    try {
      const { id } = parse(idParamsSchema, req.params);
      await conversationService.leave(this.userId(req), id);
      const body: LeaveConversationResponse = { conversationId: id };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'ConversationsController.leave');
    }
  }

  /** POST /conversations/:id/read — advance the caller's read watermark and notify the room. */
  async markRead(req: Request, res: Response): Promise<void> {
    try {
      const userId = this.userId(req);
      const { id } = parse(idParamsSchema, req.params);
      const { upToMessageId } = parse(markReadSchema, req.body);
      const { lastReadAt: at, receipts } = await conversationService.markRead(userId, id, upToMessageId);
      const lastReadAt = at.toISOString();

      if (receipts.length > 0) {
        const event: ChatReadEvent = { conversationId: id, receipts };
        emitToConversation(id, SERVER_EVENTS.CHAT_MESSAGE_READ, event);
      }

      const body: MarkReadResponse = { conversationId: id, lastReadAt };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'ConversationsController.markRead');
    }
  }
}

export const conversationsController = new ConversationsController();
