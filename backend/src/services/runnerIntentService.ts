import { z } from 'zod';
import type {
  ConversationTurn,
  ModelMessage,
  ProposedRunnerSession,
  RunnerDevice,
  RunnerHarnessId,
  RunnerSession,
} from '@stewra/shared-types';
import { RUNNER_HARNESS_IDS } from '@stewra/shared-types';
import { config } from '../config/unifiedConfig.js';
import { modelClient } from '../agent-host/modelClient.js';
import { messageRepository } from '../repositories/messageRepository.js';
import { runnerService } from './runnerService.js';
import { runnerSessionService } from './runnerSessionService.js';
import {
  runnerChatRelayService,
  type RunnerChatChannel,
} from './runnerChatRelayService.js';
import { logger } from '../utils/logger.js';

/**
 * What handling a runner-intent turn produces: the line to reply with in the arriving medium, and — only
 * for a fresh or revised proposal — a still-`pending` {@link ProposedRunnerSession} to attach to the
 * assistant message so a button-bearing surface (web/app) also renders a Start/Cancel card. Every other
 * intent (a confirmation that starts a session, a permission answer, a push) is executed here and rides
 * back as `reply` alone; `proposal` is null.
 */
export interface RunnerIntentOutcome {
  readonly reply: string;
  readonly proposal: ProposedRunnerSession | null;
}

/** What the turn is doing, as classified by the model against the live runner context. */
type RunnerIntent =
  | 'start_request'
  | 'confirm_proposal'
  | 'revise_proposal'
  | 'decline_proposal'
  | 'permission_allow'
  | 'permission_deny'
  | 'push_session'
  | 'open_pr'
  | 'cancel_session'
  | 'none';

/** Human labels for the harness ids, for the confirm line the user actually reads. */
const HARNESS_LABELS: Record<RunnerHarnessId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'gemini-cli': 'Gemini CLI',
};

/**
 * Cheap pre-filter: only spend a model call when the turn plausibly concerns a runner. A bare "yes" is
 * caught not by keyword but by there being something pending to answer — see `handle`.
 */
const LOOKS_LIKE_RUNNER_INTENT =
  /\b(run|runner|laptop|machine|desktop|repo|repository|workspace|claude|codex|gemini|push|pull request|\bpr\b|branch|agent|coding)\b/i;

/** How many recent turns of context to give the classifier (bounds the prompt). */
const CONTEXT_TURNS = 8;

const responseSchema = z.object({
  intent: z.enum([
    'start_request',
    'confirm_proposal',
    'revise_proposal',
    'decline_proposal',
    'permission_allow',
    'permission_deny',
    'push_session',
    'open_pr',
    'cancel_session',
    'none',
  ]),
  /** For start_request / revise_proposal: the chosen device/workspace/harness ids, copied from context. */
  deviceId: z.string().default(''),
  workspaceId: z.string().default(''),
  harness: z.string().default(''),
  /** The instruction to give the agent (start_request / revise_proposal). */
  prompt: z.string().default(''),
  /** One short, natural sentence to reply with, in Stewra's voice. */
  reply: z.string().default(''),
});

const SYSTEM_PROMPT = [
  'You are the runner-control router for Stewra. Stewra can host coding agents (Claude Code, Codex,',
  'Gemini CLI) on the USER\'S OWN machines and run them against their repos. Decide what the latest user',
  'message is doing with respect to that, given the live context you are handed (which machines are',
  'online and what they can run, any proposal awaiting the user\'s yes/no, any permission a running',
  'session is blocked on, and any finished work).',
  '',
  'Respond with ONLY a JSON object — no prose, no code fences — of shape:',
  '{"intent": string, "deviceId": string, "workspaceId": string, "harness": string, "prompt": string, "reply": string}',
  '',
  'intent is exactly one of:',
  '- "start_request": the user is asking to run something on a machine. Fill deviceId, workspaceId and',
  '  harness by COPYING the ids from the context (never invent one); choose the machine/workspace the',
  '  user named, or the only online one if unambiguous. Put the coding instruction in "prompt".',
  '- "confirm_proposal": there is a proposal awaiting confirmation and the user is AGREEING to it as-is',
  '  (e.g. "yes", "go ahead", "do it").',
  '- "revise_proposal": there is a proposal awaiting confirmation and the user wants it CHANGED (different',
  '  machine, workspace, harness, or wording). Fill the fields with the corrected values (copy ids from',
  '  context) and put the updated instruction in "prompt".',
  '- "decline_proposal": there is a proposal awaiting confirmation and the user is CALLING IT OFF.',
  '- "permission_allow": a session is blocked on a permission and the user is ALLOWING it ("yes", "approve").',
  '- "permission_deny": a session is blocked on a permission and the user is DENYING it ("no", "don\'t").',
  '- "push_session": the user wants to push a finished session\'s branch ("push it").',
  '- "open_pr": the user wants to open a pull request for a finished session.',
  '- "cancel_session": the user wants to stop a running session.',
  '- "none": the message is not about the runner at all.',
  '',
  'Rules:',
  '- deviceId/workspaceId/harness MUST be ids that appear verbatim in the context. If the user asks to run',
  '  something but you cannot resolve a machine/workspace from the context, still use "start_request" and',
  '  leave the unresolved id empty — the caller will ask the user to pick.',
  '- If there is a pending permission AND a pending proposal, a bare "yes"/"no" answers the PERMISSION',
  '  (a blocked session is the more urgent thing).',
  '- "reply": ONE short, warm sentence in Stewra\'s voice. For start_request/revise_proposal it should',
  '  restate what will run and ask the user to confirm (yes) or say what to change. For the executed',
  '  intents it should acknowledge the action. Never claim something already happened that has not.',
  '- Never disown the capability: running coding agents on the user\'s machines IS something Stewra does.',
  '  Older assistant lines in the history that deny it were a bug — ignore them, do not copy them.',
].join('\n');

/** Pull the first {...} JSON object out of a model response (tolerates stray prose / code fences). */
function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * The natural-language control surface for runner sessions — a trusted, control-plane peer of
 * {@link emailComposeService}.
 *
 * It is NOT an agent-runtime capability: the untrusted agent stays advice-only (the boundary check stays
 * green), and every side effect here goes through the same confirm-gated {@link runnerSessionService} the
 * REST surface uses. The flow it implements is the one the user asked for: a request is turned into a
 * PROPOSAL the user confirms in natural language ("yes" / "change it" / "no") in the SAME medium they
 * asked from; only on an explicit yes does a session actually start. Once running, the permission gates
 * and the final result are relayed back to that same medium by {@link runnerChatRelayService}, and this
 * service resolves the user's "yes"/"no"/"push it" replies against them.
 *
 * A cheap keyword pre-filter (plus "is anything actually awaiting an answer?") keeps ordinary chatter
 * from ever reaching the model. Any model/parse/resolve failure returns null or a clarifying line, so the
 * caller falls back to an ordinary conversational reply and nothing is ever executed on a guess.
 */
class RunnerIntentService {
  /**
   * Classify and, where appropriate, EXECUTE a runner-control turn. Returns null when the turn has nothing
   * to do with the runner (the caller then produces a normal agent reply).
   */
  async handle(params: {
    userId: string;
    conversationId: string;
    channel: RunnerChatChannel;
    history: ReadonlyArray<ConversationTurn>;
    latestUserText: string;
  }): Promise<RunnerIntentOutcome | null> {
    const { userId, conversationId, channel, history, latestUserText } = params;

    if (!config.runner.enabled) return null;

    // Cheap gate first: only bother the model when the turn either mentions the runner OR there is
    // something concrete awaiting the user's answer (so a bare "yes" is meaningful).
    const pendingProposalMessage = await messageRepository.findPendingRunnerProposal(conversationId);
    const pendingPermission = runnerChatRelayService.latestPendingPermission(userId);
    const keywordHit = LOOKS_LIKE_RUNNER_INTENT.test(latestUserText);
    if (!keywordHit && pendingProposalMessage === undefined && pendingPermission === null) {
      return null;
    }

    const { devices } = await runnerService.listDevices(userId);
    const online = devices.filter((d) => d.online);
    const sessions = (await runnerSessionService.listSessions(userId)).sessions;

    const context = this.buildContext(
      online,
      pendingProposalMessage?.proposedRunnerSession ?? null,
      pendingPermission,
      sessions,
    );
    const messages: ModelMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          'Live runner context:',
          context,
          '',
          'Recent conversation:',
          history
            .slice(-CONTEXT_TURNS)
            .map((t) => `${t.role === 'assistant' ? 'Stewra' : 'User'}: ${t.content}`)
            .join('\n'),
          '',
          `Latest user message:\n${latestUserText}`,
        ].join('\n'),
      },
    ];

    const runStructured =
      modelClient.completeStructured?.bind(modelClient) ?? modelClient.complete.bind(modelClient);
    let raw: string;
    try {
      raw = await runStructured(messages);
    } catch (error) {
      logger.warn('runner-intent classification failed; falling back to normal reply', {
        err: String(error),
      });
      return null;
    }

    const parsed = responseSchema.safeParse(extractJsonObject(raw));
    if (!parsed.success) return null;
    const data = parsed.data;
    const intent: RunnerIntent = data.intent;

    switch (intent) {
      case 'start_request':
        return this.propose(online, data.deviceId, data.workspaceId, data.harness, data.prompt, data.reply);
      case 'revise_proposal':
        return this.revise(
          online,
          pendingProposalMessage,
          data.deviceId,
          data.workspaceId,
          data.harness,
          data.prompt,
          data.reply,
        );
      case 'confirm_proposal':
        return this.confirm(userId, conversationId, channel, pendingProposalMessage, data.reply);
      case 'decline_proposal':
        return this.decline(pendingProposalMessage, data.reply);
      case 'permission_allow':
        return this.decidePermission(userId, pendingPermission, true, data.reply);
      case 'permission_deny':
        return this.decidePermission(userId, pendingPermission, false, data.reply);
      case 'push_session':
        return this.push(userId, sessions, data.reply);
      case 'open_pr':
        return this.openPr(userId, sessions, data.reply);
      case 'cancel_session':
        return this.cancelSession(userId, sessions, data.reply);
      case 'none':
      default:
        return null;
    }
  }

  // ── proposal lifecycle ───────────────────────────────────────────────────────────────────────────────

  /** A fresh "run X on machine Y" ask → a pending proposal + a confirm question. Nothing starts yet. */
  private propose(
    online: readonly RunnerDevice[],
    deviceId: string,
    workspaceId: string,
    harness: string,
    prompt: string,
    modelReply: string,
  ): RunnerIntentOutcome | null {
    if (online.length === 0) {
      return {
        reply: 'None of your runner machines are online right now, so there\'s nothing to run this on.',
        proposal: null,
      };
    }
    if (prompt.trim().length === 0) {
      return { reply: 'What would you like the coding agent to do?', proposal: null };
    }

    const resolved = this.resolve(online, deviceId, workspaceId, harness);
    if (typeof resolved === 'string') return { reply: resolved, proposal: null };

    const proposal: ProposedRunnerSession = {
      status: 'pending',
      deviceId: resolved.device.id,
      deviceName: resolved.device.name,
      workspaceId: resolved.workspace.id,
      workspaceName: resolved.workspace.name,
      harness: resolved.harness,
      prompt: prompt.trim(),
      sessionId: null,
      failureReason: null,
    };
    const reply =
      modelReply.trim().length > 0
        ? modelReply.trim()
        : `I'll run "${proposal.prompt}" with ${HARNESS_LABELS[proposal.harness]} on ${proposal.deviceName} (${proposal.workspaceName}). Reply "yes" to start, or tell me what to change.`;
    return { reply, proposal };
  }

  /** The user amended a pending proposal → re-propose with the corrected fields (still pending). */
  private async revise(
    online: readonly RunnerDevice[],
    pendingMessage: Awaited<ReturnType<typeof messageRepository.findPendingRunnerProposal>>,
    deviceId: string,
    workspaceId: string,
    harness: string,
    prompt: string,
    modelReply: string,
  ): Promise<RunnerIntentOutcome | null> {
    const current = pendingMessage?.proposedRunnerSession;
    if (pendingMessage === undefined || current === null || current === undefined) {
      // Nothing to revise — treat it as a fresh request instead.
      return this.propose(online, deviceId, workspaceId, harness, prompt, modelReply);
    }
    // Carry forward whatever the user did NOT change (an empty field from the model = unchanged).
    const nextDeviceId = deviceId.trim().length > 0 ? deviceId : current.deviceId;
    const nextWorkspaceId = workspaceId.trim().length > 0 ? workspaceId : current.workspaceId;
    const nextHarness = harness.trim().length > 0 ? harness : current.harness;
    const nextPrompt = prompt.trim().length > 0 ? prompt : current.prompt;

    const outcome = this.propose(online, nextDeviceId, nextWorkspaceId, nextHarness, nextPrompt, modelReply);
    if (outcome === null || outcome.proposal === null) return outcome;

    // Supersede the previous pending card so only the newest one is confirmable.
    await messageRepository.updateProposedRunnerSession(pendingMessage.id, { ...current, status: 'cancelled' });
    return outcome;
  }

  /** The user confirmed → start the session on the chosen machine and register where to relay it back. */
  private async confirm(
    userId: string,
    conversationId: string,
    channel: RunnerChatChannel,
    pendingMessage: Awaited<ReturnType<typeof messageRepository.findPendingRunnerProposal>>,
    modelReply: string,
  ): Promise<RunnerIntentOutcome | null> {
    const proposal = pendingMessage?.proposedRunnerSession;
    if (pendingMessage === undefined || proposal === null || proposal === undefined) {
      return { reply: 'There\'s nothing waiting to start right now.', proposal: null };
    }
    const { reply } = await this.startProposedSession(userId, pendingMessage.id, proposal, conversationId, channel);
    return { reply: modelReply.trim().length > 0 ? modelReply.trim() : reply, proposal: null };
  }

  /**
   * Start the session a message's `pending` proposal describes, register the chat to relay it back to,
   * and fold the outcome into that message's proposal (`sent` | `failed`). Shared by the natural-language
   * "yes" and the web/app Start button — the single confirm-gated path from a proposal to a live session,
   * so both surfaces start it identically. Returns whether it started plus a human line for the caller to
   * relay. Never throws for an ordinary start failure — that is captured on the proposal as `failed`.
   */
  async startProposedSession(
    userId: string,
    messageId: string,
    proposal: ProposedRunnerSession,
    conversationId: string,
    channel: RunnerChatChannel,
  ): Promise<{ started: boolean; reply: string }> {
    try {
      const session = await runnerSessionService.startSession(userId, {
        deviceId: proposal.deviceId,
        harness: proposal.harness,
        workspaceId: proposal.workspaceId,
        prompt: proposal.prompt,
      });

      if (session.status === 'failed') {
        await messageRepository.updateProposedRunnerSession(messageId, {
          ...proposal,
          status: 'failed',
          sessionId: session.id,
          failureReason: session.error,
        });
        return {
          started: false,
          reply: `I couldn't start it on ${proposal.deviceName}${session.error ? `: ${session.error}` : '.'}`,
        };
      }

      // Remember which chat to relay this session's permission gates and result back to.
      runnerChatRelayService.registerOrigin(session.id, {
        userId,
        conversationId,
        channel,
        deviceName: proposal.deviceName,
        workspaceName: proposal.workspaceName,
      });
      await messageRepository.updateProposedRunnerSession(messageId, {
        ...proposal,
        status: 'sent',
        sessionId: session.id,
        failureReason: null,
      });
      return {
        started: true,
        reply: `Started on ${proposal.deviceName}. I'll let you know here if it needs you, or when it's done.`,
      };
    } catch (error) {
      logger.warn('runner-intent failed to start proposed session', { err: String(error), userId });
      return { started: false, reply: 'Something went wrong starting that session. Please try again.' };
    }
  }

  /** The user called off a pending proposal → mark it cancelled. */
  private async decline(
    pendingMessage: Awaited<ReturnType<typeof messageRepository.findPendingRunnerProposal>>,
    modelReply: string,
  ): Promise<RunnerIntentOutcome | null> {
    const proposal = pendingMessage?.proposedRunnerSession;
    if (pendingMessage === undefined || proposal === null || proposal === undefined) {
      return { reply: 'There\'s nothing waiting that I need to cancel.', proposal: null };
    }
    await messageRepository.updateProposedRunnerSession(pendingMessage.id, { ...proposal, status: 'cancelled' });
    return {
      reply: modelReply.trim().length > 0 ? modelReply.trim() : 'Okay, I won\'t run that.',
      proposal: null,
    };
  }

  // ── in-flight actions ────────────────────────────────────────────────────────────────────────────────

  /** Relay the user's yes/no on a blocked session's permission gate back down to the runner. */
  private async decidePermission(
    userId: string,
    pending: ReturnType<typeof runnerChatRelayService.latestPendingPermission>,
    allow: boolean,
    modelReply: string,
  ): Promise<RunnerIntentOutcome | null> {
    if (pending === null) {
      return { reply: 'There\'s no permission waiting on an answer right now.', proposal: null };
    }
    const optionId = allow ? pending.allowOptionId : pending.denyOptionId;
    if (optionId === null) {
      return { reply: 'I couldn\'t find a matching option for that on the session.', proposal: null };
    }
    try {
      await runnerSessionService.decidePermission(userId, pending.sessionId, pending.promptId, optionId);
      runnerChatRelayService.clearPermission(pending.sessionId);
      const fallback = allow ? 'Approved — carrying on.' : 'Denied — I told it not to.';
      return { reply: modelReply.trim().length > 0 ? modelReply.trim() : fallback, proposal: null };
    } catch (error) {
      logger.warn('runner-intent permission decision failed', { err: String(error), userId });
      return {
        reply: 'I couldn\'t deliver that answer to the session — it may have already moved on.',
        proposal: null,
      };
    }
  }

  /** Push the most recent finished-with-branch session's branch to its remote. */
  private async push(
    userId: string,
    sessions: readonly RunnerSession[],
    modelReply: string,
  ): Promise<RunnerIntentOutcome | null> {
    const target =
      sessions.find((s) => s.endedAt !== null && s.branch !== null && !s.pushed) ??
      sessions.find((s) => s.endedAt !== null && s.branch !== null);
    if (target === undefined) {
      return { reply: 'There\'s no finished session with a branch to push.', proposal: null };
    }
    try {
      const { remoteUrl } = await runnerSessionService.pushSession(userId, target.id);
      const where = remoteUrl ? ` to ${remoteUrl}` : '';
      return {
        reply: modelReply.trim().length > 0 ? modelReply.trim() : `Pushed ${target.branch}${where}.`,
        proposal: null,
      };
    } catch (error) {
      return { reply: `I couldn't push that: ${this.errText(error)}`, proposal: null };
    }
  }

  /** Open a PR for the most recent finished-with-branch session. */
  private async openPr(
    userId: string,
    sessions: readonly RunnerSession[],
    modelReply: string,
  ): Promise<RunnerIntentOutcome | null> {
    const target =
      sessions.find((s) => s.endedAt !== null && s.branch !== null && s.prUrl === null) ??
      sessions.find((s) => s.endedAt !== null && s.branch !== null);
    if (target === undefined) {
      return { reply: 'There\'s no finished session with a branch to open a PR for.', proposal: null };
    }
    const firstLine = target.prompt.split('\n')[0];
    const title = firstLine !== undefined && firstLine.length > 0 ? firstLine.slice(0, 120) : 'Stewra runner session';
    const body = target.summary ?? target.prompt;
    try {
      const { prUrl } = await runnerSessionService.openPr(userId, target.id, title, body);
      return {
        reply: modelReply.trim().length > 0 ? modelReply.trim() : `Opened a pull request: ${prUrl}`,
        proposal: null,
      };
    } catch (error) {
      return { reply: `I couldn't open a PR: ${this.errText(error)}`, proposal: null };
    }
  }

  /** Stop the most recent still-running session. */
  private async cancelSession(
    userId: string,
    sessions: readonly RunnerSession[],
    modelReply: string,
  ): Promise<RunnerIntentOutcome | null> {
    const target = sessions.find((s) => s.endedAt === null);
    if (target === undefined) {
      return { reply: 'You don\'t have a running session to stop.', proposal: null };
    }
    try {
      await runnerSessionService.cancel(userId, target.id);
      return {
        reply: modelReply.trim().length > 0 ? modelReply.trim() : `Stopping the session on ${target.deviceName}.`,
        proposal: null,
      };
    } catch (error) {
      return { reply: `I couldn't stop that session: ${this.errText(error)}`, proposal: null };
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Resolve the model's chosen ids against the LIVE online devices — the model's output is untrusted, so
   * a device/workspace/harness it names must actually exist and be runnable before we build a proposal.
   * Returns the resolved trio, or a user-facing clarifying line when it can't be pinned down.
   */
  private resolve(
    online: readonly RunnerDevice[],
    deviceId: string,
    workspaceId: string,
    harness: string,
  ): { device: RunnerDevice; workspace: RunnerDevice['workspaces'][number]; harness: RunnerHarnessId } | string {
    const device = online.find((d) => d.id === deviceId) ?? (online.length === 1 ? online[0] : undefined);
    if (device === undefined) {
      const names = online.map((d) => d.name).join(', ');
      return `Which machine should I use — ${names}?`;
    }

    const harnessId = this.asHarnessId(harness);
    const usable = device.harnesses.filter((h) => h.available);
    const preferred = harnessId !== null && usable.some((h) => h.id === harnessId) ? harnessId : undefined;
    const chosenHarness = preferred ?? usable[0]?.id;
    if (chosenHarness === undefined) {
      return `${device.name} doesn't have a coding agent available right now.`;
    }

    const workspace =
      device.workspaces.find((w) => w.id === workspaceId) ??
      (device.workspaces.length === 1 ? device.workspaces[0] : undefined);
    if (workspace === undefined) {
      const names = device.workspaces.map((w) => w.name).join(', ');
      return names.length > 0
        ? `Which repo on ${device.name} — ${names}?`
        : `${device.name} has no workspaces exposed to run against.`;
    }

    return { device, workspace, harness: chosenHarness };
  }

  private asHarnessId(value: string): RunnerHarnessId | null {
    return RUNNER_HARNESS_IDS.find((id) => id === value) ?? null;
  }

  /** A compact, id-bearing snapshot of the live runner state for the classifier to choose from. */
  private buildContext(
    online: readonly RunnerDevice[],
    pendingProposal: ProposedRunnerSession | null,
    pendingPermission: ReturnType<typeof runnerChatRelayService.latestPendingPermission>,
    sessions: readonly RunnerSession[],
  ): string {
    const lines: string[] = [];

    if (online.length === 0) {
      lines.push('Online machines: none.');
    } else {
      lines.push('Online machines:');
      for (const d of online) {
        const harnesses = d.harnesses.filter((h) => h.available).map((h) => h.id).join(', ') || 'none';
        const workspaces = d.workspaces.map((w) => `${w.name} [id=${w.id}]`).join(', ') || 'none';
        lines.push(`- ${d.name} [deviceId=${d.id}] (${d.os}); harnesses: ${harnesses}; workspaces: ${workspaces}`);
      }
    }

    if (pendingProposal !== null) {
      lines.push(
        `Proposal awaiting confirmation: run "${pendingProposal.prompt}" with ${pendingProposal.harness} ` +
          `on ${pendingProposal.deviceName} (${pendingProposal.workspaceName}).`,
      );
    } else {
      lines.push('Proposal awaiting confirmation: none.');
    }

    if (pendingPermission !== null) {
      lines.push(`Permission awaiting an answer: "${pendingPermission.title}".`);
    } else {
      lines.push('Permission awaiting an answer: none.');
    }

    const running = sessions.filter((s) => s.endedAt === null);
    const finishedWithBranch = sessions.filter((s) => s.endedAt !== null && s.branch !== null);
    lines.push(
      `Running sessions: ${running.length}. Finished sessions with a pushable branch: ${finishedWithBranch.length}.`,
    );

    return lines.join('\n');
  }

  private errText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

export const runnerIntentService = new RunnerIntentService();
