import type { ModelMessage } from '@stewra/shared-types';
import { modelClient } from '../agent-host/modelClient.js';
import { auditWriter } from '../control-plane/audit/auditWriter.js';
import { emailThreadRepository, emailMessageRepository } from '../repositories/emailStore.js';
import { processMemoryService } from './processMemoryService.js';
import { memoryService } from './memoryService.js';
import { NotFoundError } from '../utils/errors.js';

/** Cap the thread context fed to the model when drafting. */
const THREAD_CONTEXT_LIMIT = 20;

/**
 * Drafts a reply to a thread in the user's learned style. Trusted control-plane consumer of the model
 * (a peer of insightService): it reads the decrypted thread + the user's process/style rules and past
 * exemplars, and returns TEXT ONLY. It never sends — sending is the confirm-gated executor (phase 2).
 */
class DraftService {
  async draftReply(userId: string, threadId: string, addedInfo?: string): Promise<string> {
    const thread = await emailThreadRepository.findByIdForUser(threadId, userId);
    if (thread === undefined) {
      throw new NotFoundError('Email thread not found');
    }
    const messages = await emailMessageRepository.forThread(userId, threadId, THREAD_CONTEXT_LIMIT);
    const styleRules = await processMemoryService.recall(userId, 'email');
    const exemplars = await memoryService.recall(userId, 'gmail', 'draft a reply');

    const transcript = messages
      .map((m) => {
        const who = m.direction === 'inbound' ? 'Them' : 'You';
        const text = m.body.length > 0 ? m.body : m.snippet;
        return `${who}: ${text}`.slice(0, 2000);
      })
      .join('\n\n');

    const systemParts = [
      'You are Stewra, drafting an email reply on the user\'s behalf for them to review. Write only ' +
        'the reply body — no subject line, no commentary, no placeholders like [Name] unless the ' +
        'thread makes the name clear. Keep it ready to send.',
    ];
    if (styleRules.length > 0) {
      systemParts.push(
        `How this user likes their email written:\n${styleRules.map((r) => `- ${r}`).join('\n')}`,
      );
    }
    if (exemplars.length > 0) {
      systemParts.push(
        `Past replies the user rated well (learn from, don't copy):\n${exemplars
          .map((e) => `- ${e}`)
          .join('\n')}`,
      );
    }

    const userParts = [`Thread (subject: ${thread.subject || '(no subject)'}):\n${transcript}`];
    if (addedInfo && addedInfo.trim().length > 0) {
      userParts.push(`Extra instruction from the user for this reply:\n${addedInfo.trim()}`);
    }
    userParts.push('Write the reply now.');

    const modelMessages: ModelMessage[] = [
      { role: 'system', content: systemParts.join('\n\n') },
      { role: 'user', content: userParts.join('\n\n') },
    ];
    const draft = (await modelClient.complete(modelMessages)).trim();

    await auditWriter.write({
      userId,
      action: 'draft',
      resourceType: 'email',
      resourceId: threadId,
      summary: `Drafted a reply for "${thread.subject || '(no subject)'}"`,
      success: true,
      metadata: { threadId },
    });

    return draft;
  }
}

export const draftService = new DraftService();
