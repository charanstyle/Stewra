import { z } from 'zod';
import * as Sentry from '@sentry/node';
import type {
  Briefing,
  BriefingSection,
  ModelMessage,
  SuggestionOption,
  SuggestionSourceRef,
} from '@stewra/shared-types';
import { config } from '../config/unifiedConfig';
import { modelClient } from '../agent-host/modelClient';
import { vault } from '../control-plane/vault/vault';
import { auditWriter } from '../control-plane/audit/auditWriter';
import { connectionRepository } from '../repositories/connectionRepository';
import { fetchUpcomingEvents } from './googleOAuthService';
import { extractCalendarFacts } from './calendarFacts';
import {
  emailThreadRepository,
  emailMessageRepository,
  type EmailThreadRow,
} from '../repositories/emailStore';
import { briefingRepository } from '../repositories/briefingRepository';
import { suggestionRepository } from '../repositories/suggestionRepository';
import { isBulkCategory } from './emailClassification';
import { processMemoryService } from './processMemoryService';
import { logger } from '../utils/logger';

/**
 * Builds the proactive briefing + nudges (control plane, trusted — a peer of insightService). It reads
 * the DECRYPTED email store + calendar facts + the user's style, and calls the model DIRECTLY for the
 * natural-language briefing. This is the deliberate two-plane note: bodies live in the control plane
 * and are summarised by this trusted orchestrator, NOT through the broker and NOT inside the agent
 * runtime — the broker/minimized-facts contract is untouched, so `npm run boundaries` stays green.
 *
 * Nudges are derived DETERMINISTICALLY from the email data (so an option's action targets a REAL
 * thread), not invented by the model — the model only writes the briefing prose. If the model's
 * structured output can't be parsed, the briefing degrades to a deterministic summary (never crashes).
 */

/** The model's briefing contract — prose only; nudges are code-derived. */
const BriefingModelSchema = z.object({
  summary: z.string(),
  sections: z
    .array(z.object({ heading: z.string(), body: z.string() }))
    .default([]),
});

class BriefingService {
  /** Compute and persist the user's current briefing + open nudges. */
  async computeAndStore(userId: string): Promise<Briefing> {
    const awaitingThreads = await this.genuineAwaitingThreads(userId);
    const recent = await emailMessageRepository.recent(userId, config.briefing.contextMessages);
    const unreadCount = recent.filter((m) => m.labelIds.includes('UNREAD')).length;
    const calendarFacts = await this.calendarFactsFor(userId);
    const styleRules = await processMemoryService.recall(userId, 'email');

    const { summary, sections } = await this.generateBriefingProse({
      unreadCount,
      recentCount: recent.length,
      recentSubjects: recent.slice(0, 10).map((m) => m.subject).filter((s) => s.length > 0),
      awaitingSubjects: awaitingThreads.map((t) => t.subject),
      calendarFacts,
      styleRules,
    });

    const briefing = await briefingRepository.upsertForUser(userId, summary, sections);
    await this.upsertNudges(userId, awaitingThreads);

    await auditWriter.write({
      userId,
      action: 'brief',
      resourceType: 'system',
      resourceId: null,
      summary: 'Refreshed your daily briefing',
      success: true,
      metadata: { nudges: awaitingThreads.length, unread: unreadCount },
    });

    return briefing;
  }

  /**
   * The threads genuinely awaiting the user's reply — a person is waiting, not a newsletter or promo.
   * Bulk mail can still carry awaiting_reply=true (rows synced before this rule, or a category Gmail
   * applied after we stored the message), so re-check each candidate's latest message against the bulk
   * categories and SELF-HEAL the flag when it was wrong. That keeps "Reply to 'Get 15% off'" out of the
   * nudges AND out of the "waiting on you" count. Over-fetch so genuine threads aren't crowded out of the
   * window by bulk ones, then cap at maxNudges.
   */
  private async genuineAwaitingThreads(userId: string): Promise<ReadonlyArray<EmailThreadRow>> {
    const cap = config.briefing.maxNudges;
    const candidates = await emailThreadRepository.listAwaitingReply(userId, cap * 4);
    const genuine: EmailThreadRow[] = [];
    for (const thread of candidates) {
      const latest = await emailMessageRepository.latestInThread(thread.id);
      const stillAwaiting =
        latest !== undefined && latest.direction === 'inbound' && !isBulkCategory(latest.labelIds);
      if (stillAwaiting) {
        genuine.push(thread);
      } else {
        // Correct the stored flag so this thread stops being counted/surfaced on later runs.
        await emailThreadRepository.setAwaitingReply(thread.id, false);
      }
    }
    return genuine.slice(0, cap);
  }

  /** Calendar facts for the user's first active Google account; empty on any failure (calendar is
   * optional to the briefing). */
  private async calendarFactsFor(userId: string): Promise<ReadonlyArray<string>> {
    try {
      const connections = await connectionRepository.listActive(userId, 'google');
      const connection = connections[0];
      if (connection === undefined) {
        return [];
      }
      const refreshToken = await vault.get(connection.vaultRef);
      const events = await fetchUpcomingEvents(refreshToken);
      return extractCalendarFacts(events, new Date());
    } catch (error) {
      Sentry.captureException(error);
      return [];
    }
  }

  /** Ask the model for the briefing prose; degrade to a deterministic summary if it can't be parsed. */
  private async generateBriefingProse(context: {
    unreadCount: number;
    recentCount: number;
    recentSubjects: ReadonlyArray<string>;
    awaitingSubjects: ReadonlyArray<string>;
    calendarFacts: ReadonlyArray<string>;
    styleRules: ReadonlyArray<string>;
  }): Promise<{ summary: string; sections: ReadonlyArray<BriefingSection> }> {
    const factLines: string[] = [
      `${context.unreadCount} unread of the ${context.recentCount} most recent emails.`,
      context.awaitingSubjects.length > 0
        ? `${context.awaitingSubjects.length} thread(s) awaiting your reply: ${context.awaitingSubjects
            .map((s) => `"${s || '(no subject)'}"`)
            .join(', ')}.`
        : 'No threads are waiting on your reply.',
      ...context.calendarFacts.map((f) => `Calendar: ${f}`),
      ...context.recentSubjects.map((s) => `Recent subject: ${s}`),
    ];

    const system =
      'You are Stewra, a warm, concise personal assistant giving the user their daily briefing. ' +
      'From the facts, write a short first-person-to-the-user summary (2-4 sentences) and a few ' +
      'titled sections (e.g. Inbox, Waiting on you, Calendar). Respond with ONLY a JSON object of ' +
      'the form {"summary": string, "sections": [{"heading": string, "body": string}]}. No prose ' +
      'outside the JSON, no code fences.';
    const user = `Facts:\n${factLines.map((f) => `- ${f}`).join('\n')}`;
    const messages: ModelMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];

    const parsed = await this.tryStructured(messages);
    if (parsed !== null) {
      return { summary: parsed.summary, sections: parsed.sections };
    }
    // Degrade: a deterministic, honest summary from the same facts, no sections.
    logger.info('briefing: model output unparseable, using deterministic summary');
    return { summary: factLines.join(' '), sections: [] };
  }

  /** Call the model (structured path when available), extract + validate JSON, with one repair retry. */
  private async tryStructured(
    messages: ModelMessage[],
  ): Promise<{ summary: string; sections: BriefingSection[] } | null> {
    const call = (): Promise<string> =>
      modelClient.completeStructured
        ? modelClient.completeStructured(messages)
        : modelClient.complete(messages);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const raw = await call();
        const json = extractJsonObject(raw);
        if (json === null) {
          continue;
        }
        const result = BriefingModelSchema.safeParse(JSON.parse(json));
        if (result.success) {
          return { summary: result.data.summary, sections: result.data.sections };
        }
      } catch (error) {
        Sentry.captureException(error);
      }
    }
    return null;
  }

  /** Turn each awaiting-reply thread into an open nudge, upserted by a stable dedup key. */
  private async upsertNudges(
    userId: string,
    awaitingThreads: ReadonlyArray<{ id: string; subject: string }>,
  ): Promise<void> {
    for (const thread of awaitingThreads) {
      const label = thread.subject || '(no subject)';
      const sourceRefs: ReadonlyArray<SuggestionSourceRef> = [
        { kind: 'email_thread', ref: thread.id, label },
      ];
      const options: ReadonlyArray<SuggestionOption> = [
        {
          id: `draft:${thread.id}`,
          label: 'Draft a reply',
          action: { type: 'reply_email', targetRefs: { threadId: thread.id } },
        },
      ];
      await suggestionRepository.upsertByDedup(userId, {
        dedupKey: `needs_reply:${thread.id}`,
        kind: 'needs_reply',
        title: `Reply to "${label}"`,
        rationale: "They're waiting on your reply — the last message in this thread was theirs.",
        sourceRefs,
        options,
      });
    }
  }
}

/** Extract the first balanced JSON object from a model response (tolerates code fences / stray text). */
function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return raw.slice(start, end + 1);
}

export const briefingService = new BriefingService();
