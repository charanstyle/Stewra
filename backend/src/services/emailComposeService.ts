import { z } from 'zod';
import type { ConversationTurn, ModelMessage } from '@stewra/shared-types';
import { modelClient } from '../agent-host/modelClient.js';
import { logger } from '../utils/logger.js';

/** The extracted draft the user will confirm before anything is sent. */
export interface EmailProposalDraft {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}

/** A detected "please send an email" turn: Stewra's chat line offering it + the draft to attach. */
export interface EmailProposalResult {
  readonly reply: string;
  readonly draft: EmailProposalDraft;
}

/** A pragmatic email-address check — good enough to reject a non-address the model might echo back. */
const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Cheap pre-filter: only spend a model call when the turn plausibly asks to send an email. */
const LOOKS_LIKE_EMAIL_INTENT = /\b(e-?mails?|send)\b/i;

/** How many recent turns of context to give the extractor (bounds the prompt). */
const CONTEXT_TURNS = 8;

const responseSchema = z.object({
  isSendEmailRequest: z.boolean(),
  to: z.string().default(''),
  subject: z.string().default(''),
  body: z.string().default(''),
  reply: z.string().default(''),
});

const SYSTEM_PROMPT = [
  'You decide whether the latest user message is asking Stewra to SEND AN EMAIL on their behalf, and',
  'if so you extract the email. Respond with ONLY a JSON object — no prose, no code fences — of shape:',
  '{"isSendEmailRequest": boolean, "to": string, "subject": string, "body": string, "reply": string}',
  'Rules:',
  '- isSendEmailRequest is true ONLY when the latest message asks to send or compose an email to someone.',
  "- \"to\": the recipient's email address EXACTLY as it appears in the conversation. If there is no",
  '  explicit email address, set isSendEmailRequest to false.',
  '- "subject": a short, fitting subject line; synthesize one if the user did not give it.',
  '- "body": the message to send, in the user\'s voice (e.g. if they said "saying hi", the body is "Hi").',
  '- "reply": ONE short, warm sentence telling the user you have prepared the draft for THEM to review',
  '  and send. Frame the user as the one who sends it. NEVER offer to send it yourself, NEVER ask',
  '  "want me to send it", and NEVER claim you already sent it.',
  '- If it is not an email-send request, set isSendEmailRequest false and leave the other fields empty.',
].join('\n');

/** Pull the first {...} JSON object out of a model response (tolerates stray prose / code fences). */
function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Detects an "email Stewra to send…" turn and, when found, drafts the email for the user to confirm.
 *
 * This runs in the TRUSTED control plane (a peer of `draftService`), calling the model directly — it is
 * NOT a new agent-runtime capability, so the agent stays advice-only and the boundary check stays green.
 * It only ever produces a DRAFT + a confirmation line; nothing is sent here. A cheap keyword pre-filter
 * keeps ordinary chatter from ever reaching the model. Any model/parse failure returns null, so the
 * caller simply falls back to a normal conversational reply.
 */
class EmailComposeService {
  async maybePropose(
    history: ReadonlyArray<ConversationTurn>,
    latestUserText: string,
  ): Promise<EmailProposalResult | null> {
    if (!LOOKS_LIKE_EMAIL_INTENT.test(latestUserText)) {
      return null;
    }

    const contextLines = history
      .slice(-CONTEXT_TURNS)
      .map((turn) => `${turn.role === 'assistant' ? 'Stewra' : 'User'}: ${turn.content}`);
    const messages: ModelMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Recent conversation:\n${contextLines.join('\n')}\n\nLatest user message:\n${latestUserText}`,
      },
    ];

    // `completeStructured` is optional on the model interface; fall back to `complete` (the JSON
    // contract lives in the system prompt, and we validate the result either way).
    const runStructured =
      modelClient.completeStructured?.bind(modelClient) ?? modelClient.complete.bind(modelClient);
    let raw: string;
    try {
      raw = await runStructured(messages);
    } catch (error) {
      logger.warn('email-intent extraction failed; falling back to normal reply', {
        err: String(error),
      });
      return null;
    }

    const parsed = responseSchema.safeParse(extractJsonObject(raw));
    if (!parsed.success) {
      return null;
    }
    const data = parsed.data;
    const to = data.to.trim();
    const body = data.body.trim();
    if (!data.isSendEmailRequest || !EMAIL_ADDRESS.test(to) || body.length === 0) {
      return null;
    }

    const subject = data.subject.trim().length > 0 ? data.subject.trim() : '(no subject)';
    const reply =
      data.reply.trim().length > 0
        ? data.reply.trim()
        : `Here's a draft email to ${to} for you to review and send.`;
    return { reply, draft: { to, subject, body } };
  }
}

export const emailComposeService = new EmailComposeService();
