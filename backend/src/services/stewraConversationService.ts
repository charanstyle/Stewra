import { stat } from 'node:fs/promises';
import type { Conversation, ConversationTurn, Message } from '@stewra/shared-types';
import { agentRuntime } from '../agent-host/agentHost.js';
import { auditWriter } from '../control-plane/audit/auditWriter.js';
import { messageRepository } from '../repositories/messageRepository.js';
import { emailComposeService } from './emailComposeService.js';
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
  ): Promise<Message> {
    const history = await this.loadHistory(conversation.id, userMessage.id);
    const latestUserText = userMessage.transcript ?? userMessage.content ?? '';

    // If the user is asking Stewra to send an email, the (trusted) compose service drafts it for the
    // user to confirm and gives us the chat line to reply with. Otherwise we fall back to the ordinary
    // advice-only agent turn. The agent itself never sends — the draft rides on the message as a
    // `pending` proposal until the user taps Send (the confirm-gated executor).
    const proposal = await emailComposeService.maybePropose(history, latestUserText);
    const reply = proposal
      ? proposal.reply
      : await agentRuntime.converse(userId, history, latestUserText);

    const audioUrl = await this.synthesize(userId, conversation.id, reply);

    const assistantMessage = await messageRepository.create({
      conversationId: conversation.id,
      senderId: null,
      senderKind: 'assistant',
      type: 'text',
      content: reply,
      audioUrl,
      proposedEmail: proposal
        ? {
            status: 'pending',
            to: proposal.draft.to,
            subject: proposal.draft.subject,
            body: proposal.draft.body,
            provider: null,
            failureReason: null,
          }
        : null,
    });

    await auditWriter.write({
      userId,
      action: 'converse',
      resourceType: 'conversation',
      resourceId: conversation.id,
      summary: reply,
      success: true,
      metadata: { spoke: audioUrl !== null, proposedEmail: proposal !== null },
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
