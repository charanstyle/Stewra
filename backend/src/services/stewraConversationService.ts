import { stat } from 'node:fs/promises';
import type { Conversation, ConversationTurn, Message } from '@stewra/shared-types';
import { agentRuntime } from '../agent-host/agentHost.js';
import { auditWriter } from '../control-plane/audit/auditWriter.js';
import { messageRepository } from '../repositories/messageRepository.js';
import { emailComposeService } from './emailComposeService.js';
import { runnerIntentService } from './runnerIntentService.js';
import type { RunnerChatChannel } from './runnerChatRelayService.js';
import { mediaService } from './mediaService.js';
import { ttsService } from './ttsService.js';
import { logger } from '../utils/logger.js';

/** How many recent turns to hand the agent as conversation context (bounds the prompt). */
const HISTORY_LIMIT = 20;

/** WAV is what Piper writes; the assistant clip is served as audio/wav via GET /media/:id. */
const TTS_MIME = 'audio/wav';

/**
 * The CONTROL-PLANE wrapper around a Talk-to-Stewra turn — the one surface where the agent speaks in a
 * conversation. It loads the recent turns from the DB (the agent never queries the DB — it gets them as
 * data), calls the untrusted `agentRuntime.converse`, synthesizes the reply to speech, PERSISTS the
 * assistant message, and writes the append-only audit row. This mirrors `insightService.generateAndRecord`:
 * the agent has no capability to persist or audit — the control plane owns those writes.
 */
class StewraConversationService {
  /**
   * Produce the assistant's reply to a just-persisted user turn in the user's Stewra-AI conversation.
   * Returns the stored assistant `message` (text + TTS `audioUrl`, or text-only if synthesis fails).
   */
  async generateReply(
    userId: string,
    conversation: Conversation,
    userMessage: Message,
    channel: RunnerChatChannel,
  ): Promise<Message> {
    const history = await this.loadHistory(conversation.id, userMessage.id);
    const latestUserText = userMessage.transcript ?? userMessage.content ?? '';

    // Two trusted control-plane "tools" get first refusal on the turn, in priority order, before the
    // advice-only agent. Each may attach a `pending` proposal to the message (confirm-gated: nothing
    // executes until the user says so) or, for the runner, resolve an in-flight "yes"/"no"/"push it".
    //
    //   1. Runner: start/confirm/approve a coding-agent session on the user's own machine. Its reply and
    //      any permission/result relay come back on `channel` — the SAME medium the user asked from.
    //   2. Email: draft an email for the user to review and send.
    //
    // The agent itself never sends or executes — it only produces conversational text when neither tool
    // claims the turn.
    const runnerOutcome = await runnerIntentService.handle({
      userId,
      conversationId: conversation.id,
      channel,
      history,
      latestUserText,
    });
    const emailProposal = runnerOutcome
      ? null
      : await emailComposeService.maybePropose(history, latestUserText);

    const reply = runnerOutcome
      ? runnerOutcome.reply
      : emailProposal
        ? emailProposal.reply
        : await agentRuntime.converse(userId, history, latestUserText);

    const audioUrl = await this.synthesize(userId, conversation.id, reply);

    const assistantMessage = await messageRepository.create({
      conversationId: conversation.id,
      senderId: null,
      senderKind: 'assistant',
      type: 'text',
      content: reply,
      audioUrl,
      proposedEmail: emailProposal
        ? {
            status: 'pending',
            to: emailProposal.draft.to,
            subject: emailProposal.draft.subject,
            body: emailProposal.draft.body,
            provider: null,
            failureReason: null,
          }
        : null,
      proposedRunnerSession: runnerOutcome?.proposal ?? null,
    });

    await auditWriter.write({
      userId,
      action: 'converse',
      resourceType: 'conversation',
      resourceId: conversation.id,
      summary: reply,
      success: true,
      metadata: {
        spoke: audioUrl !== null,
        proposedEmail: emailProposal !== null,
        proposedRunnerSession: runnerOutcome?.proposal != null,
      },
    });

    return assistantMessage;
  }

  /**
   * The recent turns of the conversation as model messages, oldest-first, EXCLUDING the just-persisted
   * user turn (passed separately to `converse` as the latest utterance). Only textual turns carry
   * context — call/system markers and media without a transcript are skipped.
   */
  private async loadHistory(
    conversationId: string,
    excludeMessageId: string,
  ): Promise<ConversationTurn[]> {
    // Viewer is irrelevant here — this projection only reads text/senderKind for model context, never
    // the sender-facing status ticks, so an empty viewer id is fine.
    const { items } = await messageRepository.listByConversation(
      conversationId,
      undefined,
      HISTORY_LIMIT,
      '',
    );
    const turns: ConversationTurn[] = [];
    // listByConversation returns newest-first; reverse to chronological for the model.
    for (const message of [...items].reverse()) {
      if (message.id === excludeMessageId) continue;
      const text = message.senderKind === 'user' ? message.transcript ?? message.content : message.content;
      if (text === null || text.trim().length === 0) continue;
      turns.push({ role: message.senderKind === 'assistant' ? 'assistant' : 'user', content: text });
    }
    return turns;
  }

  /**
   * Synthesize `reply` to a WAV, store it as an owner-scoped `tts_out` asset, and return its
   * `/media/:id` URL. Degrades to null (text-only reply) if synthesis fails — a broken clip must never
   * fail the whole turn.
   */
  private async synthesize(
    userId: string,
    conversationId: string,
    reply: string,
  ): Promise<string | null> {
    try {
      const { filename, absPath } = await mediaService.reserve('.wav');
      await ttsService.synthesize(reply, absPath);
      const { size } = await stat(absPath);
      const asset = await mediaService.record({
        ownerId: userId,
        conversationId,
        kind: 'tts_out',
        filename,
        mime: TTS_MIME,
        bytes: size,
      });
      return mediaService.urlFor(asset);
    } catch (err: unknown) {
      logger.warn('tts synthesis failed; returning text-only reply', {
        conversationId,
        err: String(err),
      });
      return null;
    }
  }
}

export const stewraConversationService = new StewraConversationService();
