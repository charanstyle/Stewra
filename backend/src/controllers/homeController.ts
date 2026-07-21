import type { Request, Response } from 'express';
import { z } from 'zod';
import type {
  GetBriefingResponse,
  ListSuggestionsResponse,
  SnoozeSuggestionResponse,
  DismissSuggestionResponse,
  MarkSuggestionDoneResponse,
  RequestDraftResponse,
  ChatAboutSuggestionResponse,
} from '@stewra/shared-types';
import { BaseController } from './baseController.js';
import { parse } from '../utils/validate.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import { briefingRepository } from '../repositories/briefingRepository.js';
import { suggestionRepository } from '../repositories/suggestionRepository.js';
import { suggestionService } from '../services/suggestionService.js';
import { draftService } from '../services/draftService.js';
import { briefingService } from '../services/briefingService.js';
import { gmailSyncService } from '../services/gmailSyncService.js';
import { conversationService } from '../services/conversationService.js';
import { messageService } from '../services/messageService.js';

const idParamsSchema = z.object({ id: z.string().uuid() });
const snoozeBodySchema = z.object({ until: z.string().datetime() });
const draftBodySchema = z.object({
  optionId: z.string().optional(),
  addedInfo: z.string().max(4000).optional(),
});
const chatBodySchema = z.object({ message: z.string().max(4000).optional() });

/**
 * The Today surface: the proactive briefing + nudges. Read endpoints return what the background job
 * computed; the action endpoints let the user snooze/dismiss/mark-done, request a draft (text only,
 * no send), or open a seeded chat with Stewra about a nudge.
 */
class HomeController extends BaseController {
  private userId(req: Request): string {
    const userId = req.userId;
    if (userId === undefined) {
      throw new Error('HomeController requires requireAuth middleware');
    }
    return userId;
  }

  /** GET /home/briefing */
  async getBriefing(req: Request, res: Response): Promise<void> {
    try {
      const briefing = await briefingRepository.getForUser(this.userId(req));
      const body: GetBriefingResponse = { briefing };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'HomeController.getBriefing');
    }
  }

  /** GET /home/suggestions */
  async listSuggestions(req: Request, res: Response): Promise<void> {
    try {
      const suggestions = await suggestionService.listOpen(this.userId(req));
      const body: ListSuggestionsResponse = { suggestions };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'HomeController.listSuggestions');
    }
  }

  /** POST /home/suggestions/:id/snooze */
  async snooze(req: Request, res: Response): Promise<void> {
    try {
      const { id } = parse(idParamsSchema, req.params);
      const { until } = parse(snoozeBodySchema, req.body);
      const suggestion = await suggestionService.snooze(this.userId(req), id, new Date(until));
      const body: SnoozeSuggestionResponse = { suggestion };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'HomeController.snooze');
    }
  }

  /** POST /home/suggestions/:id/dismiss */
  async dismiss(req: Request, res: Response): Promise<void> {
    try {
      const { id } = parse(idParamsSchema, req.params);
      const suggestion = await suggestionService.dismiss(this.userId(req), id);
      const body: DismissSuggestionResponse = { suggestion };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'HomeController.dismiss');
    }
  }

  /** POST /home/suggestions/:id/done */
  async markDone(req: Request, res: Response): Promise<void> {
    try {
      const { id } = parse(idParamsSchema, req.params);
      const suggestion = await suggestionService.markDone(this.userId(req), id);
      const body: MarkSuggestionDoneResponse = { suggestion };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'HomeController.markDone');
    }
  }

  /** POST /home/suggestions/:id/draft — draft a reply for a reply_email option (text only). */
  async draft(req: Request, res: Response): Promise<void> {
    try {
      const userId = this.userId(req);
      const { id } = parse(idParamsSchema, req.params);
      const { optionId, addedInfo } = parse(draftBodySchema, req.body);
      const suggestion = await suggestionRepository.findByIdForUser(id, userId);
      if (suggestion === undefined) {
        throw new NotFoundError('Suggestion not found');
      }
      // Resolve the reply target: the named option, else the first reply_email option on the nudge.
      const option =
        (optionId
          ? suggestion.options.find((o) => o.id === optionId)
          : undefined) ??
        suggestion.options.find((o) => o.action.type === 'reply_email');
      const threadId = option?.action.targetRefs['threadId'];
      if (option === undefined || option.action.type !== 'reply_email' || threadId === undefined) {
        throw new ValidationError('This suggestion has no reply to draft');
      }
      const draft = await draftService.draftReply(userId, threadId, addedInfo);
      const body: RequestDraftResponse = { draft };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'HomeController.draft');
    }
  }

  /** POST /home/suggestions/:id/chat — open a Stewra chat seeded with this nudge's context. */
  async chat(req: Request, res: Response): Promise<void> {
    try {
      const userId = this.userId(req);
      const { id } = parse(idParamsSchema, req.params);
      const { message } = parse(chatBodySchema, req.body);
      const suggestion = await suggestionRepository.findByIdForUser(id, userId);
      if (suggestion === undefined) {
        throw new NotFoundError('Suggestion not found');
      }

      const conversationSummary = await conversationService.getOrCreateStewra(userId);
      const conversationId = conversationSummary.conversation.id;
      const seed =
        `About this nudge — "${suggestion.title}": ${suggestion.rationale}` +
        (message && message.trim().length > 0 ? `\n\n${message.trim()}` : '');
      const { message: userTurn, conversation } = await messageService.sendText(
        userId,
        conversationId,
        seed,
        null,
      );
      // Generate Stewra's reply before responding so both turns exist when the client opens /stewra.
      await messageService.generateStewraReply(userId, conversation, userTurn, 'stewra_chat');

      const body: ChatAboutSuggestionResponse = { conversationId };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'HomeController.chat');
    }
  }

  /** POST /home/recompute — sync the user's mail then rebuild their briefing + nudges (manual refresh). */
  async recompute(req: Request, res: Response): Promise<void> {
    try {
      const userId = this.userId(req);
      await gmailSyncService.syncForUser(userId);
      const briefing = await briefingService.computeAndStore(userId);
      const body: GetBriefingResponse = { briefing };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'HomeController.recompute');
    }
  }
}

export const homeController = new HomeController();
