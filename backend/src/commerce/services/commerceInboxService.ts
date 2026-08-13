import type {
  CommerceConversationSummary,
  CommerceMessage,
} from '@stewra/shared-types';
import { channelAccountService } from './channelAccountService.js';
import { consentService } from './consentService.js';
import { buildSender } from './senders/index.js';
import { renderTemplateBody } from './templateBody.js';
import { templateService } from './templateService.js';
import { channelAccountRepository } from '../repositories/channelAccountRepository.js';
import { commerceInboxRepository } from '../repositories/commerceInboxRepository.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

/** Page sizes. Behaviour knobs, not targets — a caller may ask for less, never for more. */
const DEFAULT_PAGE = 30;
const MAX_PAGE = 100;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE);
}

/**
 * Cursors are the ISO timestamp of the last row on the previous page.
 *
 * A malformed cursor is rejected rather than ignored: silently treating it as "start from the top"
 * would show an agent the newest page again while they believed they were paging forward, and they
 * would never see what they skipped.
 */
function decodeCursor(cursor: string | undefined): Date | undefined {
  if (cursor === undefined) return undefined;
  const at = new Date(cursor);
  if (Number.isNaN(at.getTime())) {
    throw new ValidationError('Validation failed', [
      { field: 'cursor', message: 'Cursor is not a valid timestamp' },
    ]);
  }
  return at;
}

/** The shared inbox: reading an organization's threads, and replying inside the service window. */
class CommerceInboxService {
  async listConversations(params: {
    orgId: string;
    limit: number | undefined;
    cursor: string | undefined;
  }): Promise<{ conversations: CommerceConversationSummary[]; nextCursor: string | null }> {
    const limit = clampLimit(params.limit);
    const conversations = await commerceInboxRepository.listConversations({
      orgId: params.orgId,
      limit,
      before: decodeCursor(params.cursor),
    });
    // Only a full page can have more behind it. A short page is the end, and saying so is what stops
    // the client paging forever against an unchanging cursor.
    const last = conversations.length === limit ? conversations[conversations.length - 1] : undefined;
    return { conversations, nextCursor: last?.lastMessageAt ?? null };
  }

  async listMessages(params: {
    orgId: string;
    conversationId: string;
    limit: number | undefined;
    cursor: string | undefined;
  }): Promise<{ messages: CommerceMessage[]; nextCursor: string | null }> {
    const conversation = await commerceInboxRepository.findConversation(
      params.orgId,
      params.conversationId,
    );
    if (conversation === null) {
      throw new NotFoundError('Conversation not found');
    }

    const limit = clampLimit(params.limit);
    const newestFirst = await commerceInboxRepository.listMessages({
      orgId: params.orgId,
      conversationId: params.conversationId,
      limit,
      before: decodeCursor(params.cursor),
    });
    const oldest = newestFirst.length === limit ? newestFirst[newestFirst.length - 1] : undefined;

    // Queried newest-first so paging walks backwards; returned oldest-first so a thread reads the way
    // a conversation does.
    return { messages: [...newestFirst].reverse(), nextCursor: oldest?.createdAt ?? null };
  }

  /**
   * An agent's free-form reply.
   *
   * The service window is checked HERE rather than left to Meta, because Meta does not fail: outside
   * the 24 hours it accepts the call and never delivers the message. An agent would see their reply
   * in the thread, marked sent, and the customer would never receive it. Refusing with an explanation
   * is the only behaviour that tells the truth.
   */
  async sendReply(params: {
    orgId: string;
    conversationId: string;
    body: string;
    sentByUserId: string;
  }): Promise<CommerceMessage> {
    const conversation = await commerceInboxRepository.findConversation(
      params.orgId,
      params.conversationId,
    );
    if (conversation === null) {
      throw new NotFoundError('Conversation not found');
    }

    const expiresAt = conversation.serviceWindowExpiresAt;
    if (expiresAt === null || expiresAt.getTime() <= Date.now()) {
      throw new ForbiddenError(
        'The 24-hour reply window for this conversation has closed. Only an approved template ' +
          'message can be delivered now.',
        'SERVICE_WINDOW_CLOSED',
      );
    }

    const account = await channelAccountRepository.findForOrg(
      params.orgId,
      conversation.channelAccountId,
    );
    if (account === null) {
      throw new NotFoundError('The channel this conversation belongs to is no longer connected');
    }

    const to = await commerceInboxRepository.findContactExternalId(
      params.orgId,
      conversation.contactId,
    );
    if (to === null) {
      throw new NotFoundError('Contact not found');
    }

    // Suppression outranks the service window. Someone who said STOP has an open 24-hour window for
    // exactly as long as anyone else — the window is Meta's delivery rule, not permission — so
    // without this check a business could keep answering a person who asked to be left alone. Purpose
    // is `service`, so this asks about suppression only: no marketing consent is needed to reply to
    // someone who wrote first.
    await consentService.assertMaySend({
      orgId: params.orgId,
      contactId: conversation.contactId,
      platform: conversation.platform,
      externalId: to,
      purpose: 'service',
    });

    // The row is written BEFORE the send, so a send that fails leaves visible evidence rather than
    // vanishing. `queued` → `sent`/`failed` is the whole point of having those two states.
    const queued = await commerceInboxRepository.recordOutbound({
      orgId: params.orgId,
      conversationId: params.conversationId,
      platform: conversation.platform,
      body: params.body,
      sentByUserId: params.sentByUserId,
    });

    try {
      const sender = buildSender(await channelAccountService.resolve(account));
      const providerMessageId = await sender.sendText(to, params.body);
      return await commerceInboxRepository.settleOutbound({
        orgId: params.orgId,
        messageId: queued.id,
        status: 'sent',
        providerMessageId,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await commerceInboxRepository.settleOutbound({
        orgId: params.orgId,
        messageId: queued.id,
        status: 'failed',
        failureReason: reason,
      });
      logger.error('commerce: outbound reply failed', {
        orgId: params.orgId,
        conversationId: params.conversationId,
        error: reason,
      });
      // Re-thrown, not converted into a "queued" success: the agent must know the customer did not
      // get this, while they are still looking at the screen.
      throw error;
    }
  }

  /**
   * One approved template, into one conversation. The business-initiated half of the inbox.
   *
   * There is deliberately NO service-window check here — a template is the one thing Meta delivers
   * outside the window, and it is never less deliverable inside it. What replaces the window check
   * is the consent gate, at a purpose the TEMPLATE'S CATEGORY decides:
   *
   *   - `utility` / `authentication` → `service`: transactional content, gated on suppression only,
   *     the same permission an ordinary reply needs.
   *   - `marketing` → `marketing`: the full gate — policy, attestation, consent, quiet hours —
   *     exactly as a broadcast would face. Sending a campaign one recipient at a time through the
   *     inbox must not be cheaper, in permission terms, than sending the campaign.
   *   - a category this build does not recognize (`null`) is gated as `marketing`, because the safe
   *     reading of "we cannot tell what kind of message this is" is the strict one.
   *
   * Meta re-files templates it reads as marketing regardless of what was submitted, and the sync
   * mirrors the category Meta actually assigned — so this decision rides on Meta's judgement of the
   * content, not the client's.
   */
  async sendTemplate(params: {
    orgId: string;
    conversationId: string;
    templateId: string;
    variables: readonly string[];
    sentByUserId: string;
  }): Promise<CommerceMessage> {
    const conversation = await commerceInboxRepository.findConversation(
      params.orgId,
      params.conversationId,
    );
    if (conversation === null) {
      throw new NotFoundError('Conversation not found');
    }

    const template = await templateService.assertSendable(
      params.orgId,
      params.templateId,
      params.variables.length,
    );
    // A template belongs to one WABA. Sent through a different number, Meta rejects it — after the
    // message row exists. Refusing here names the actual mistake instead.
    if (template.channelAccountId !== conversation.channelAccountId) {
      throw new ValidationError('Validation failed', [
        {
          field: 'templateId',
          message: `Template "${template.name}" belongs to a different WhatsApp number than this conversation.`,
        },
      ]);
    }

    const account = await channelAccountRepository.findForOrg(
      params.orgId,
      conversation.channelAccountId,
    );
    if (account === null) {
      throw new NotFoundError('The channel this conversation belongs to is no longer connected');
    }

    const to = await commerceInboxRepository.findContactExternalId(
      params.orgId,
      conversation.contactId,
    );
    if (to === null) {
      throw new NotFoundError('Contact not found');
    }

    const purpose =
      template.category === 'utility' || template.category === 'authentication'
        ? 'service'
        : 'marketing';
    await consentService.assertMaySend({
      orgId: params.orgId,
      contactId: conversation.contactId,
      platform: conversation.platform,
      externalId: to,
      purpose,
    });

    // Same order as a reply: the row exists BEFORE the send, so a failure leaves evidence.
    const queued = await commerceInboxRepository.recordOutbound({
      orgId: params.orgId,
      conversationId: params.conversationId,
      platform: conversation.platform,
      body: renderTemplateBody(template.bodyText, params.variables),
      sentByUserId: params.sentByUserId,
      templateId: template.id,
    });

    try {
      const sender = buildSender(await channelAccountService.resolve(account));
      const providerMessageId = await sender.sendTemplate({
        to,
        templateName: template.name,
        languageCode: template.language,
        variables: params.variables,
      });
      return await commerceInboxRepository.settleOutbound({
        orgId: params.orgId,
        messageId: queued.id,
        status: 'sent',
        providerMessageId,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await commerceInboxRepository.settleOutbound({
        orgId: params.orgId,
        messageId: queued.id,
        status: 'failed',
        failureReason: reason,
      });
      logger.error('commerce: outbound template send failed', {
        orgId: params.orgId,
        conversationId: params.conversationId,
        templateId: params.templateId,
        error: reason,
      });
      throw error;
    }
  }
}

export const commerceInboxService = new CommerceInboxService();
