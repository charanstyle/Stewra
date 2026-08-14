import { z } from 'zod';
import type {
  CommerceConversationSummary,
  ModelMessage,
  OrgMembership,
  ProposedCommerceReply,
} from '@stewra/shared-types';
import { roleMeetsMinimum } from '@stewra/shared-types';
import * as Sentry from '@sentry/node';
import { config } from '../../config/unifiedConfig.js';
import { modelClient } from '../../agent-host/modelClient.js';
import type {
  CommerceProposalExecutor,
  ProposalExecutionRequest,
  TurnIntentHandler,
  TurnIntentOutcome,
  TurnIntentRequest,
} from '../../ports/turnIntent.js';
import { logger } from '../../utils/logger.js';
import { channelAccountService } from './channelAccountService.js';
import { commerceInboxService } from './commerceInboxService.js';
import { organizationService } from './organizationService.js';

/**
 * Cheap pre-filter: only spend a model call when the turn plausibly concerns the business inbox. A
 * bare "yes" is caught not by keyword but by there being a proposal awaiting an answer — see
 * {@link CommerceIntentService.handle}.
 */
const LOOKS_LIKE_COMMERCE_INTENT =
  /\b(inbox|customer|customers|client|clients|lead|leads|reply|replies|respond|message|messages|whatsapp|number|numbers|channel|channels|org|organisation|organization|business|workspace|thread|conversation|unread)\b/i;

/** How many recent turns of context to give the classifier (bounds the prompt). */
const CONTEXT_TURNS = 8;

/** How many threads to summarise into the model's context, and to offer in a disambiguation. */
const INBOX_CONTEXT_LIMIT = 12;

/** The minimum role that may put words in front of a customer — matches the REST reply route. */
const REPLY_MIN_ROLE = 'agent' as const;

const responseSchema = z.object({
  intent: z.enum([
    'switch_org',
    'list_channels',
    'inbox_summary',
    'read_thread',
    'reply_request',
    'confirm_reply',
    'revise_reply',
    'decline_reply',
    'none',
  ]),
  /** For switch_org: the organization id, copied verbatim from context. */
  orgId: z.string().default(''),
  /** For read_thread / reply_request: the commerce conversation id, copied verbatim from context. */
  conversationId: z.string().default(''),
  /** For reply_request / revise_reply: exactly what to say to the customer. */
  body: z.string().default(''),
  /** One short, natural sentence to reply with, in Stewra's voice. */
  reply: z.string().default(''),
});

const SYSTEM_PROMPT = [
  'You are the business-inbox router for Stewra. A Stewra user may belong to organizations that talk',
  'to their own customers on WhatsApp. Decide what the latest user message is doing with respect to',
  'that, given the live context you are handed (which organizations they belong to and which one is',
  'active, the connected numbers, the recent customer threads, and any reply awaiting a yes/no).',
  '',
  'Respond with ONLY a JSON object — no prose, no code fences — of shape:',
  '{"intent": string, "orgId": string, "conversationId": string, "body": string, "reply": string}',
  '',
  'intent is exactly one of:',
  '- "switch_org": the user wants to act on a different organization. Copy its id into orgId.',
  '- "list_channels": the user is asking which numbers/channels are connected.',
  '- "inbox_summary": the user is asking what is in the inbox / what is new / who is waiting.',
  '- "read_thread": the user wants to read one customer thread. Copy its id into conversationId.',
  '- "reply_request": the user wants to SEND something to a customer. Copy the thread id into',
  '  conversationId and put the exact words for the customer in "body". Write "body" as a message to',
  '  the CUSTOMER, not about them — no "tell her that", just what she should read.',
  '- "confirm_reply": a reply is awaiting confirmation and the user is AGREEING to send it as-is',
  '  ("yes", "send it", "go ahead").',
  '- "revise_reply": a reply is awaiting confirmation and the user wants the WORDING changed. Put the',
  '  corrected message in "body".',
  '- "decline_reply": a reply is awaiting confirmation and the user is CALLING IT OFF.',
  '- "none": the message is not about the business inbox at all.',
  '',
  'Rules:',
  '- orgId and conversationId MUST appear verbatim in the context. NEVER invent one. If the user',
  '  clearly wants to reply but you cannot tell which thread, still use "reply_request" and leave',
  '  conversationId empty — the caller will ask them to pick.',
  '- Personal messages the user is sending as THEMSELVES are not business replies. "text my wife" is',
  '  "none". Only a message to one of the CUSTOMERS listed in the context is "reply_request".',
  '- "reply": ONE short, warm sentence in Stewra\'s voice. For reply_request/revise_reply it should',
  '  read back what will be sent and to whom, and ask them to confirm. Never claim something has',
  '  already been sent when it has not.',
].join('\n');

/** Pull the first {...} JSON object out of a model response (tolerates stray prose / code fences). */
function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    // A model that answered with prose is not an error condition — it means "no structured intent",
    // and the caller's fallback is an ordinary conversational reply. Returning null says exactly that.
    return null;
  }
}

/** How a thread is named in the confirm line, when the platform gave us no profile name. */
function contactLabel(thread: CommerceConversationSummary): string {
  return thread.contactDisplayName ?? thread.contactPhoneE164 ?? 'this customer';
}

/**
 * The natural-language control surface for an organization's shared inbox — the headline of the
 * commerce plane, since the product promise is that a business runs its commercial funnel BY TEXTING
 * STEWRA, with the app as the fallback rather than the other way round.
 *
 * Built on the {@link runnerIntentService} template and keeping its two load-bearing habits:
 *
 *  1. **The model's output is untrusted.** Every id it produces is resolved against a real row the
 *     asking user is actually a member of. A hallucinated org id resolves to nothing and asks a
 *     question; it never becomes a send.
 *  2. **Nothing executes without an explicit confirmation.** A request becomes a `pending`
 *     {@link ProposedCommerceReply}; only a subsequent "yes" sends it.
 *
 * The second habit matters more here than anywhere else in the codebase. The runner acts on the
 * user's own machine and the email tool sends from the user's own account, but this puts words in
 * front of somebody else's customer, under a business's name, on a number that business is
 * accountable for. There is no undo on a delivered WhatsApp message.
 *
 * Registered into {@link turnIntentRegistry} at the composition root, because the personal-assistant
 * plane may not import this file.
 */
class CommerceIntentService implements TurnIntentHandler, CommerceProposalExecutor {
  readonly name = 'commerce-inbox';

  async handle(request: TurnIntentRequest): Promise<TurnIntentOutcome | null> {
    // When the commerce plane is dark there are no channels to act on, so its conversational surface
    // is dark too — the same rule `runnerIntentService` applies to `config.runner.enabled`.
    if (!config.metaCommerce.enabled) return null;

    const { userId, latestUserText, pending } = request;
    const keywordHit = LOOKS_LIKE_COMMERCE_INTENT.test(latestUserText);
    if (!keywordHit && pending === null) return null;

    const { memberships, activeOrgId } = await organizationService.listOrgs(userId);
    if (memberships.length === 0) return null;

    const active = this.activeMembership(memberships, activeOrgId);
    const threads =
      active === null
        ? []
        : (
            await commerceInboxService.listConversations({
              orgId: active.org.id,
              limit: INBOX_CONTEXT_LIMIT,
              cursor: undefined,
            })
          ).conversations;

    const raw = await this.classify(request, memberships, active, threads);
    if (raw === null) return null;

    const parsed = responseSchema.safeParse(extractJsonObject(raw));
    if (!parsed.success) return null;
    const data = parsed.data;

    switch (data.intent) {
      case 'switch_org':
        return this.switchOrg(userId, memberships, data.orgId, data.reply);
      case 'list_channels':
        return this.listChannels(active);
      case 'inbox_summary':
        return this.inboxSummary(active, threads);
      case 'read_thread':
        return this.readThread(active, threads, data.conversationId);
      case 'reply_request':
        return this.propose(active, threads, data.conversationId, data.body, data.reply);
      case 'revise_reply':
        return this.revise(request, active, threads, data.body, data.reply);
      case 'confirm_reply':
        return this.confirm(request, data.reply);
      case 'decline_reply':
        return this.decline(request, data.reply);
      case 'none':
      default:
        return null;
    }
  }

  // ── classification ───────────────────────────────────────────────────────────────────────────────

  /** Ask the model what the turn is doing. Returns null on any model failure (caller falls back). */
  private async classify(
    request: TurnIntentRequest,
    memberships: readonly OrgMembership[],
    active: OrgMembership | null,
    threads: readonly CommerceConversationSummary[],
  ): Promise<string | null> {
    const messages: ModelMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          'Live business context:',
          this.buildContext(memberships, active, threads, request.pending),
          '',
          'Recent conversation:',
          request.history
            .slice(-CONTEXT_TURNS)
            .map((t) => `${t.role === 'assistant' ? 'Stewra' : 'User'}: ${t.content}`)
            .join('\n'),
          '',
          `Latest user message:\n${request.latestUserText}`,
        ].join('\n'),
      },
    ];

    const runStructured =
      modelClient.completeStructured?.bind(modelClient) ?? modelClient.complete.bind(modelClient);
    try {
      return await runStructured(messages);
    } catch (error) {
      // Recovery is correct and narrow: the turn falls back to an ordinary conversational reply and
      // nothing is executed. The cause is recorded rather than hidden.
      // The recovery is right; the silence was not. Without this, a model outage degrades every
      // commerce turn to small talk and looks, from outside, exactly like nobody using the feature.
      Sentry.captureException(error, { tags: { plane: 'commerce', step: 'intent_classification' } });
      logger.warn('commerce-intent classification failed; falling back to a normal reply', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** The live rows the model is allowed to choose from. Every id it may echo back appears here. */
  private buildContext(
    memberships: readonly OrgMembership[],
    active: OrgMembership | null,
    threads: readonly CommerceConversationSummary[],
    pending: TurnIntentRequest['pending'],
  ): string {
    const lines: string[] = ['Organizations:'];
    for (const m of memberships) {
      const marker = active !== null && m.org.id === active.org.id ? ' [ACTIVE]' : '';
      lines.push(`- id=${m.org.id} name="${m.org.name}" yourRole=${m.role}${marker}`);
    }

    if (active === null) {
      lines.push('', 'No organization is active, so no threads are listed.');
      return lines.join('\n');
    }

    lines.push('', `Customer threads in "${active.org.name}" (newest first):`);
    if (threads.length === 0) {
      lines.push('- (none yet)');
    }
    const now = Date.now();
    for (const t of threads) {
      const open =
        t.serviceWindowExpiresAt !== null && new Date(t.serviceWindowExpiresAt).getTime() > now;
      lines.push(
        `- id=${t.id} contact="${contactLabel(t)}" replyWindow=${open ? 'OPEN' : 'CLOSED'} ` +
          `lastMessage="${t.lastMessagePreview.slice(0, 120)}"`,
      );
    }

    if (pending !== null) {
      lines.push(
        '',
        'AWAITING CONFIRMATION — a reply the user has not yet approved:',
        `- to="${pending.proposal.contactName}" body="${pending.proposal.body}"`,
      );
    }
    return lines.join('\n');
  }

  // ── read-only intents ────────────────────────────────────────────────────────────────────────────

  private switchOrg(
    userId: string,
    memberships: readonly OrgMembership[],
    orgId: string,
    modelReply: string,
  ): Promise<TurnIntentOutcome> {
    return (async (): Promise<TurnIntentOutcome> => {
      // Resolved against the user's OWN memberships, so a model-invented id cannot point at a tenant
      // they do not belong to. `setActiveOrg` re-checks membership too; this is the cheaper first gate.
      const target = memberships.find((m) => m.org.id === orgId);
      if (target === undefined) {
        const names = memberships.map((m) => `"${m.org.name}"`).join(', ');
        return { reply: `Which business did you mean — ${names}?`, proposal: null };
      }
      await organizationService.setActiveOrg(userId, target.org.id);
      return {
        reply:
          modelReply.trim().length > 0
            ? modelReply.trim()
            : `Switched to ${target.org.name}. What would you like to do?`,
        proposal: null,
      };
    })();
  }

  private async listChannels(active: OrgMembership | null): Promise<TurnIntentOutcome> {
    if (active === null) return this.noActiveOrg();
    const accounts = await channelAccountService.listForOrg(active.org.id);
    if (accounts.length === 0) {
      return {
        reply: `${active.org.name} has no WhatsApp number connected yet — you can connect one from the Channels page.`,
        proposal: null,
      };
    }
    const lines = accounts.map((a) => `• ${a.displayName} (${a.status})`).join('\n');
    return { reply: `${active.org.name} is connected to:\n${lines}`, proposal: null };
  }

  private inboxSummary(
    active: OrgMembership | null,
    threads: readonly CommerceConversationSummary[],
  ): Promise<TurnIntentOutcome> {
    if (active === null) return Promise.resolve(this.noActiveOrgSync());
    if (threads.length === 0) {
      return Promise.resolve({
        reply: `Nothing in ${active.org.name}'s inbox yet.`,
        proposal: null,
      });
    }
    const now = Date.now();
    const lines = threads.slice(0, 5).map((t) => {
      const open =
        t.serviceWindowExpiresAt !== null && new Date(t.serviceWindowExpiresAt).getTime() > now;
      // The closed-window note is not decoration: outside 24 hours a free-form reply cannot be
      // delivered at all, and an inbox summary that hides that invites a reply that silently fails.
      return `• ${contactLabel(t)}: ${t.lastMessagePreview.slice(0, 80)}${open ? '' : '  (reply window closed)'}`;
    });
    const more = threads.length > 5 ? `\n…and ${threads.length - 5} more.` : '';
    return Promise.resolve({
      reply: `${active.org.name}'s inbox:\n${lines.join('\n')}${more}`,
      proposal: null,
    });
  }

  private async readThread(
    active: OrgMembership | null,
    threads: readonly CommerceConversationSummary[],
    conversationId: string,
  ): Promise<TurnIntentOutcome> {
    if (active === null) return this.noActiveOrg();
    const thread = this.resolveThread(threads, conversationId);
    if (typeof thread === 'string') return { reply: thread, proposal: null };

    const { messages } = await commerceInboxService.listMessages({
      orgId: active.org.id,
      conversationId: thread.id,
      limit: 10,
      cursor: undefined,
    });
    if (messages.length === 0) {
      return { reply: `Nothing in the thread with ${contactLabel(thread)} yet.`, proposal: null };
    }
    const lines = messages.map(
      (m) => `${m.direction === 'inbound' ? contactLabel(thread) : 'You'}: ${m.body}`,
    );
    return { reply: `Thread with ${contactLabel(thread)}:\n${lines.join('\n')}`, proposal: null };
  }

  // ── the confirm-gated reply ──────────────────────────────────────────────────────────────────────

  /** A fresh "tell X that Y" → a pending proposal and a confirm question. Nothing is sent yet. */
  private async propose(
    active: OrgMembership | null,
    threads: readonly CommerceConversationSummary[],
    conversationId: string,
    body: string,
    modelReply: string,
  ): Promise<TurnIntentOutcome> {
    if (active === null) return this.noActiveOrg();

    // The role gate is applied here, not only on the REST route: the conversational surface is a real
    // way in, and a viewer who could message customers by texting Stewra would make the role hierarchy
    // decorative on the surface the product leads with.
    if (!roleMeetsMinimum(active.role, REPLY_MIN_ROLE)) {
      return {
        reply: `You have read-only access to ${active.org.name}, so I can't send messages to its customers.`,
        proposal: null,
      };
    }

    const trimmed = body.trim();
    if (trimmed.length === 0) {
      return { reply: 'What would you like me to say to them?', proposal: null };
    }

    const thread = this.resolveThread(threads, conversationId);
    if (typeof thread === 'string') return { reply: thread, proposal: null };

    // Refused at proposal time rather than at send time. Meta accepts a free-form message outside the
    // 24-hour window and then never delivers it, so a proposal we know cannot be delivered would be a
    // promise we cannot keep — better to say so before the user says yes.
    const expiresAt = thread.serviceWindowExpiresAt;
    if (expiresAt === null || new Date(expiresAt).getTime() <= Date.now()) {
      return {
        reply:
          `It's been more than 24 hours since ${contactLabel(thread)} last wrote, so WhatsApp won't ` +
          `deliver a normal reply. That needs an approved template message.`,
        proposal: null,
      };
    }

    const proposal: ProposedCommerceReply = {
      status: 'pending',
      orgId: active.org.id,
      orgName: active.org.name,
      conversationId: thread.id,
      contactName: contactLabel(thread),
      body: trimmed,
      messageId: null,
      failureReason: null,
    };
    return {
      reply:
        modelReply.trim().length > 0
          ? modelReply.trim()
          : `I'll send ${contactLabel(thread)} this from ${active.org.name}:\n\n"${trimmed}"\n\nReply "yes" to send, or tell me what to change.`,
      proposal,
    };
  }

  /** The user amended a pending reply → re-propose with the new wording, still pending. */
  private async revise(
    request: TurnIntentRequest,
    active: OrgMembership | null,
    threads: readonly CommerceConversationSummary[],
    body: string,
    modelReply: string,
  ): Promise<TurnIntentOutcome> {
    const pending = request.pending;
    if (pending === null) {
      // Nothing to revise — treat it as a fresh request against whatever thread was named.
      return this.propose(active, threads, '', body, modelReply);
    }
    const outcome = await this.propose(
      active,
      threads,
      pending.proposal.conversationId,
      body.trim().length > 0 ? body : pending.proposal.body,
      modelReply,
    );
    if (outcome.proposal === null) return outcome;

    // Supersede the previous card so only the newest one is confirmable — otherwise a stale "yes"
    // could send wording the user has already corrected.
    await request.settle(pending.messageId, { ...pending.proposal, status: 'cancelled' });
    return outcome;
  }

  /** The explicit yes, said in words. Delegates to the same executor the app's Send button uses. */
  private async confirm(
    request: TurnIntentRequest,
    modelReply: string,
  ): Promise<TurnIntentOutcome> {
    const pending = request.pending;
    if (pending === null) {
      return { reply: "There's nothing waiting to be sent right now.", proposal: null };
    }

    try {
      await this.execute({
        userId: request.userId,
        messageId: pending.messageId,
        proposal: pending.proposal,
        action: 'send',
        settle: request.settle,
      });
    } catch (error) {
      // Reported to the user in the same breath, never converted into a success: the one thing worse
      // than a reply that did not send is a user who believes it did. The proposal itself was already
      // marked `failed` inside `execute`, so the card and the sentence agree.
      const reason = error instanceof Error ? error.message : String(error);
      return {
        reply: `I couldn't send that to ${pending.proposal.contactName}: ${reason}`,
        proposal: null,
      };
    }

    return {
      reply:
        modelReply.trim().length > 0
          ? modelReply.trim()
          : `Sent to ${pending.proposal.contactName}.`,
      proposal: null,
    };
  }

  /**
   * THE one path in this file that puts a message in front of a customer.
   *
   * Both triggers land here — a natural-language "yes" (via {@link confirm}) and the Send button on
   * the card in the chat thread (via `messageService.confirmCommerceReplyAction`). Deliberately one
   * function: two copies would eventually disagree about a gate, and the copy that lost one would be
   * the copy nobody re-reads.
   *
   * The window check, the tenancy check and the queued→sent/failed row all live one layer down in
   * `commerceInboxService.sendReply`, which this does not duplicate. What it adds is settling the
   * PROPOSAL, so the card in the chat stops offering to send something that already went (or already
   * failed).
   */
  async execute(request: ProposalExecutionRequest): Promise<void> {
    const { messageId, proposal, settle } = request;

    if (request.action === 'cancel') {
      await settle(messageId, { ...proposal, status: 'cancelled' });
      return;
    }

    try {
      const sent = await commerceInboxService.sendReply({
        orgId: proposal.orgId,
        conversationId: proposal.conversationId,
        body: proposal.body,
        sentByUserId: request.userId,
      });
      await settle(messageId, { ...proposal, status: 'sent', messageId: sent.id });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await settle(messageId, { ...proposal, status: 'failed', failureReason: reason });
      // capture-ok: re-thrown below, and BaseController.handleError captures it once at the edge.
      logger.warn('commerce: reply failed to send', {
        orgId: proposal.orgId,
        conversationId: proposal.conversationId,
        error: reason,
      });
      // Re-thrown after recording: the caller has to be able to tell the user, while they are still
      // looking at the screen.
      throw error;
    }
  }

  private async decline(
    request: TurnIntentRequest,
    modelReply: string,
  ): Promise<TurnIntentOutcome> {
    const pending = request.pending;
    if (pending === null) {
      return { reply: "There's nothing waiting to be sent right now.", proposal: null };
    }
    await this.execute({
      userId: request.userId,
      messageId: pending.messageId,
      proposal: pending.proposal,
      action: 'cancel',
      settle: request.settle,
    });
    return {
      reply: modelReply.trim().length > 0 ? modelReply.trim() : 'Left it unsent.',
      proposal: null,
    };
  }

  // ── helpers ──────────────────────────────────────────────────────────────────────────────────────

  /**
   * The membership the user's conversational turns act on. Falls back to their only organization when
   * none is explicitly active — but NEVER picks one when there are several, because guessing which
   * business a message goes out from is the one guess this service must not make.
   */
  private activeMembership(
    memberships: readonly OrgMembership[],
    activeOrgId: string | null,
  ): OrgMembership | null {
    if (activeOrgId !== null) {
      const found = memberships.find((m) => m.org.id === activeOrgId);
      if (found !== undefined) return found;
    }
    return memberships.length === 1 ? (memberships[0] ?? null) : null;
  }

  /**
   * Resolve the model's chosen thread against the LIVE list for the active org. Returns the thread, or
   * a user-facing clarifying line when it cannot be pinned down. An id that is not in this list is
   * either hallucinated or belongs to another tenant; both get the same answer, which is a question.
   */
  private resolveThread(
    threads: readonly CommerceConversationSummary[],
    conversationId: string,
  ): CommerceConversationSummary | string {
    const found = threads.find((t) => t.id === conversationId);
    if (found !== undefined) return found;
    if (threads.length === 0) return 'There are no customer conversations in this inbox yet.';
    const names = threads.slice(0, 5).map((t) => contactLabel(t)).join(', ');
    return `Which conversation did you mean — ${names}?`;
  }

  private noActiveOrg(): Promise<TurnIntentOutcome> {
    return Promise.resolve(this.noActiveOrgSync());
  }

  private noActiveOrgSync(): TurnIntentOutcome {
    return {
      reply: 'Which business did you mean? Tell me the name and I\'ll switch to it.',
      proposal: null,
    };
  }
}

export const commerceIntentService = new CommerceIntentService();
