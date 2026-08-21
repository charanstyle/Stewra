import { z } from 'zod';
import type {
  ConversationTurn,
  ModelMessage,
  Project,
  ProjectWorkspaceBinding,
  ProposedRunnerSession,
  RunnerDevice,
  RunnerHarnessId,
  RunnerSession,
} from '@stewra/shared-types';
import { RUNNER_HARNESS_IDS } from '@stewra/shared-types';
import * as Sentry from '@sentry/node';
import { config } from '../config/unifiedConfig.js';
import { modelClient } from '../agent-host/modelClient.js';
import { messageRepository } from '../repositories/messageRepository.js';
import { projectRepository } from '../repositories/projectRepository.js';
import { runnerService } from './runnerService.js';
import type { OrgActor } from './runnerService.js';
import { runnerSessionService } from './runnerSessionService.js';
import { organizationRepository } from '../tenancy/repositories/organizationRepository.js';
import { organizationService } from '../tenancy/services/organizationService.js';
import { ChoiceRequiredError } from '../utils/errors.js';
import {
  runnerChatRelayService,
  type PendingRunnerPermission,
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
  | 'list_sessions'
  | 'list_devices'
  | 'none';

/** Human labels for the harness ids, for the confirm line the user actually reads. */
const HARNESS_LABELS: Record<RunnerHarnessId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'gemini-cli': 'Gemini CLI',
};

/**
 * Cheap pre-filter: only spend a model call when the turn plausibly concerns a runner. A bare "yes" is
 * caught not by keyword but by there being something pending to answer — see `handle`. The project
 * names the person actually uses are added per turn by {@link looksLikeRunnerIntent}: "start a session
 * on Truetalk" has no generic runner word in it, and it is the most ordinary thing anyone will say.
 */
const BASE_RUNNER_WORDS =
  /\b(run|runner|laptop|machine|desktop|mac mini|macbook|repo|repository|workspace|project|session|worktree|commit|lint|tests?|test suite|claude|codex|gemini|push|pull request|pr|branch|agent|coding|what'?s running|is .* (up|online|offline))\b/i;

/** Lowercase, alphanumerics only — how a spoken name survives a transcriber's spacing and casing. */
export function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Does this turn plausibly concern the runner? Generic words, or any of the person's project names or
 * aliases (normalized, so "true talk" still finds Truetalk). Names shorter than three characters are
 * ignored — they would match inside ordinary words.
 */
export function looksLikeRunnerIntent(text: string, projects: readonly Project[]): boolean {
  if (BASE_RUNNER_WORDS.test(text)) return true;
  const haystack = normalizeName(text);
  if (haystack.length === 0) return false;
  for (const project of projects) {
    for (const name of [project.name, ...project.aliases]) {
      const needle = normalizeName(name);
      if (needle.length >= 3 && haystack.includes(needle)) return true;
    }
  }
  return false;
}

/**
 * The three clarifying questions {@link RunnerIntentService.resolve} can ask when a run request cannot
 * be pinned to one checkout. None of them creates a proposal, so the turn that answers one ("on the Mac
 * mini") has nothing to confirm — it must be read as the original request with the blank filled in.
 * Kept as one predicate so the sentences in `resolve` and this recognizer cannot drift apart unnoticed.
 */
export function isClarifyingAsk(text: string | null): boolean {
  if (text === null) return false;
  return (
    /is ready on more than one machine — .+\. Which one\?$/.test(text) ||
    /^Which project — .+\?/.test(text) ||
    /^Which checkout on .+ — .+\?$/.test(text)
  );
}

/**
 * Did the user's words name this machine? The whole name normalized ("on the mac mini" → "macmini"), or
 * any word of it at least four characters long ("mini", "macbook") — "pro" and "mac" alone would match
 * almost anything. Used to refuse a deviceId the model supplied without the user saying it.
 */
export function userNamedDevice(text: string, deviceName: string): boolean {
  const haystack = normalizeName(text);
  if (haystack.length === 0) return false;
  if (haystack.includes(normalizeName(deviceName))) return true;
  return deviceName
    .split(/[^A-Za-z0-9]+/)
    .map((w) => normalizeName(w))
    .some((w) => w.length >= 4 && haystack.includes(w));
}

/** The most recent Stewra line in the history, or null when the user has spoken only. */
export function lastAssistantTurn(history: ReadonlyArray<ConversationTurn>): string | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i];
    if (turn !== undefined && turn.role === 'assistant') return turn.content.trim();
  }
  return null;
}

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
    'list_sessions',
    'list_devices',
    'none',
  ]),
  /** For start_request / revise_proposal: the chosen ids, copied from context. */
  projectId: z.string().default(''),
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
  'Gemini CLI) on the USER\'S OWN machines and run them against their PROJECTS. Decide what the latest user',
  'message is doing with respect to that, given the live context you are handed (the projects and which',
  'machines have each one ready, the machines themselves, any proposal awaiting the user\'s yes/no, any',
  'permission a running session is blocked on, and any finished work).',
  '',
  'Respond with ONLY a JSON object — no prose, no code fences — of shape:',
  '{"intent": string, "projectId": string, "deviceId": string, "workspaceId": string, "harness": string, "prompt": string, "reply": string}',
  '',
  'intent is exactly one of:',
  '- "start_request": the user is asking to run something. Fill projectId with the project they named (by',
  '  name OR alias — "RankRise" may be an alias of another project) by COPYING its id from the context.',
  '  Fill deviceId only if they named a machine. Fill workspaceId only if they named a raw checkout that',
  '  is not a project. Fill harness if they named an agent. Put the coding instruction in "prompt".',
  '- "confirm_proposal": there is a proposal awaiting confirmation and the user is AGREEING to it as-is',
  '  (e.g. "yes", "go ahead", "do it").',
  '- "revise_proposal": there is a proposal awaiting confirmation and the user wants it CHANGED (different',
  '  project, machine, harness, or wording). Fill the fields with the corrected values (copy ids from',
  '  context) and put the updated instruction in "prompt".',
  '- "decline_proposal": there is a proposal awaiting confirmation and the user is CALLING IT OFF.',
  '- "permission_allow": a session is blocked on a permission and the user is ALLOWING it ("yes", "approve").',
  '- "permission_deny": a session is blocked on a permission and the user is DENYING it ("no", "don\'t").',
  '- "push_session": the user wants to push a finished session\'s branch ("push it").',
  '- "open_pr": the user wants to open a pull request for a finished session.',
  '- "cancel_session": the user wants to stop a running session.',
  '- "list_sessions": the user asks what is running, or what happened ("what\'s running?", "status?").',
  '- "list_devices": the user asks about the machines ("is the Mac mini up?", "which machines are online?").',
  '- "none": the message is not about the runner at all.',
  '',
  'Rules:',
  '- Every id MUST appear verbatim in the context. NEVER choose a machine the user did not name: if a',
  '  project is ready on several machines, leave deviceId empty — the caller asks the user which one.',
  '  If you cannot resolve a project from the context, still use "start_request" with projectId empty.',
  '- If there is a pending permission AND a pending proposal, a bare "yes"/"no" answers the PERMISSION',
  '  (a blocked session is the more urgent thing).',
  '- When Stewra\'s previous line was a CLARIFYING QUESTION about a run request that could not be pinned',
  '  down ("… is ready on more than one machine — A or B. Which one?", "Which project — …?", "Which',
  '  checkout on …?") and the user answers it ("the Mac mini", "on the MacBook Pro", "Truetalk"), that is a',
  '  "start_request" — NOT confirm_proposal, because no proposal exists yet. Carry the task ("prompt"), the',
  '  project and anything else from the original ask in the recent conversation, and fill in the field the',
  '  user just answered (copy its id from the context). If instead they REPEAT the request without naming',
  '  a machine, leave deviceId empty again — guessing the machine they did not name is the one thing this',
  '  must never do; Stewra will simply ask again.',
  '- A message that itself states what to run and where ("start a session on Truetalk and fix the failing',
  '  test") is ALWAYS a "start_request", whatever Stewra said just before — even right after a proposal was',
  '  confirmed, declined or cancelled. "confirm_proposal" is only for bare assent to a proposal that is',
  '  still pending.',
  '- "reply": ONE short, warm sentence in Stewra\'s voice. For start_request/revise_proposal it should',
  '  restate what will run — use the PROJECT\'s name, not the repo folder — and ask the user to confirm',
  '  (yes) or say what to change. For the executed intents it should acknowledge the action. Never claim',
  '  something already happened that has not.',
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

/** A project, a machine, and the checkout that IS the project on that machine — resolved against live state. */
interface ResolvedTarget {
  readonly device: RunnerDevice;
  readonly workspace: RunnerDevice['workspaces'][number];
  readonly harness: RunnerHarnessId;
  readonly project: Project | null;
}

/** Everything the classifier and the resolver look at for one turn, fetched once. */
interface TurnState {
  readonly actor: OrgActor;
  readonly projects: readonly Project[];
  readonly bindings: readonly ProjectWorkspaceBinding[];
  readonly online: readonly RunnerDevice[];
  readonly devices: readonly RunnerDevice[];
  readonly sessions: readonly RunnerSession[];
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
 * Projects are what people name. The model copies a project id from the context; `resolve` turns it into
 * a machine and a checkout using the org's bindings and each machine's live hello — and when more than
 * one machine has the project ready and the user named none, it ASKS. It never picks.
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

    // Cheap gate first: only bother the model when the turn either mentions the runner — by a generic
    // word or by one of the person's own project names — OR there is something concrete awaiting the
    // user's answer (so a bare "yes" is meaningful). The names come from every org the person is in,
    // because the gate runs before any org is chosen.
    const pendingProposalMessage = await messageRepository.findPendingRunnerProposal(conversationId);
    const pendingPermission = await runnerChatRelayService.latestPendingPermission(userId);
    const everyProject = await this.projectsAcrossOrgs(userId);
    if (
      !looksLikeRunnerIntent(latestUserText, everyProject) &&
      pendingProposalMessage === undefined &&
      pendingPermission === null
    ) {
      return null;
    }

    // A chat carries no `:orgId`. The org is the one the person is acting in; with several and no
    // active one, the honest answer is a question — never the first membership.
    const actor = await this.resolveActor(userId);
    if (typeof actor === 'string') return { reply: actor, proposal: null };

    const state = await this.loadState(actor, everyProject);
    const context = this.buildContext(
      state,
      pendingProposalMessage?.proposedRunnerSession ?? null,
      pendingPermission,
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
          ...(isClarifyingAsk(lastAssistantTurn(history))
            ? [
                'Note: Stewra\'s previous line was a clarifying question about an unresolved run request',
                '(no proposal exists yet). If the latest message answers it, classify as "start_request"',
                'carrying the original task and project from the conversation above.',
                '',
              ]
            : []),
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
      // Same shape as the commerce classifier: `null` cannot distinguish "no intent" from "the model
      // call threw", and a persistent throw makes the whole runner surface look unused rather than broken.
      Sentry.captureException(error, { tags: { surface: 'runner_intent', step: 'classification' } });
      logger.warn('runner-intent classification failed; falling back to normal reply', {
        err: String(error),
      });
      return null;
    }

    const parsed = responseSchema.safeParse(extractJsonObject(raw));
    if (!parsed.success) return null;
    const data = parsed.data;
    const intent: RunnerIntent = data.intent;

    // The trust boundary for the machine: a device is chosen only when the user's own words name it.
    // The model has been seen filling deviceId with a plausible machine when a request was merely
    // repeated after "Which one?" — a silent pick, which is the one thing this surface must never do.
    // With the id blanked, `resolve` asks again (or uses the single ready machine, which is not a guess).
    if (data.deviceId.trim().length > 0) {
      const device = state.devices.find((d) => d.id === data.deviceId);
      if (device === undefined || !userNamedDevice(latestUserText, device.name)) {
        logger.info('runner-intent: dropping a deviceId the user did not name', {
          deviceId: data.deviceId,
          device: device?.name ?? null,
        });
        data.deviceId = '';
      }
    }

    switch (intent) {
      case 'start_request':
        return this.propose(state, data, data.prompt, data.reply);
      case 'revise_proposal':
        return this.revise(state, pendingProposalMessage, data, data.prompt, data.reply);
      case 'confirm_proposal':
        return this.confirm(userId, conversationId, channel, pendingProposalMessage, data.reply);
      case 'decline_proposal':
        return this.decline(pendingProposalMessage, data.reply);
      case 'permission_allow':
        return this.decidePermission(actor, pendingPermission, true, data.reply);
      case 'permission_deny':
        return this.decidePermission(actor, pendingPermission, false, data.reply);
      case 'push_session':
        return this.push(actor, state.sessions, data.reply);
      case 'open_pr':
        return this.openPr(actor, state.sessions, data.reply);
      case 'cancel_session':
        return this.cancelSession(actor, state.sessions, data.reply);
      case 'list_sessions':
        return { reply: this.describeSessions(state.sessions), proposal: null };
      case 'list_devices':
        return { reply: this.describeDevices(state), proposal: null };
      case 'none':
      default:
        return null;
    }
  }

  /**
   * The org a chat turn acts in, or the sentence to send back when that is a question. Zero memberships
   * is impossible by construction (every account is an org) and so is left to throw.
   */
  private async resolveActor(userId: string): Promise<OrgActor | string> {
    try {
      const { orgId } = await organizationService.resolveActingOrg(userId);
      return { orgId, userId };
    } catch (error) {
      if (error instanceof ChoiceRequiredError) {
        const names = error.details.map((d) => d.message).join(', ');
        return `Which organization do you mean — ${names}? Pick one in Stewra under Organizations ("Use this one when I text Stewra"), then ask again.`;
      }
      throw error;
    }
  }

  /** Live projects from every org the person belongs to — for the gate, which runs before an org is chosen. */
  private async projectsAcrossOrgs(userId: string): Promise<Project[]> {
    const memberships = await organizationRepository.listForUser(userId);
    const all: Project[] = [];
    for (const m of memberships) all.push(...(await projectRepository.list(m.org.id, false)));
    return all;
  }

  private async loadState(actor: OrgActor, everyProject: readonly Project[]): Promise<TurnState> {
    const projects = everyProject.filter((p) => p.orgId === actor.orgId);
    const [bindings, { devices }, { sessions }] = await Promise.all([
      projectRepository.listBindingsForOrg(actor.orgId),
      runnerService.listDevices(actor.orgId),
      runnerSessionService.listSessions(actor.orgId),
    ]);
    // A cloud runner counts as available even when its container is stopped: starting it is Stewra's
    // job, and `startSession` wakes it. Only a machine of the user's own is genuinely unreachable when
    // offline — nothing here can turn a laptop on.
    const online = devices.filter((d) => d.online || d.kind === 'hosted');
    return { actor, projects, bindings, online, devices, sessions };
  }

  // ── proposal lifecycle ───────────────────────────────────────────────────────────────────────────────

  /** A fresh "run X on Y" ask → a pending proposal + a confirm question. Nothing starts yet. */
  private propose(
    state: TurnState,
    ids: { projectId: string; deviceId: string; workspaceId: string; harness: string },
    prompt: string,
    modelReply: string,
  ): RunnerIntentOutcome | null {
    if (state.online.length === 0) {
      return {
        reply:
          'You have no runner available right now — set up a cloud runner in Stewra, or start the runner on one of your own machines.',
        proposal: null,
      };
    }
    if (prompt.trim().length === 0) {
      return { reply: 'What would you like the coding agent to do?', proposal: null };
    }

    const resolved = this.resolve(state, ids);
    if (typeof resolved === 'string') return { reply: resolved, proposal: null };

    const proposal: ProposedRunnerSession = {
      status: 'pending',
      deviceId: resolved.device.id,
      deviceName: resolved.device.name,
      workspaceId: resolved.workspace.id,
      workspaceName: resolved.workspace.name,
      projectId: resolved.project?.id ?? null,
      projectName: resolved.project?.name ?? null,
      harness: resolved.harness,
      prompt: prompt.trim(),
      sessionId: null,
      failureReason: null,
    };
    const what = proposal.projectName ?? proposal.workspaceName;
    const reply =
      modelReply.trim().length > 0
        ? modelReply.trim()
        : `I'll run "${proposal.prompt}" with ${HARNESS_LABELS[proposal.harness]} on ${what} (${proposal.deviceName}). Reply "yes" to start, or tell me what to change.`;
    return { reply, proposal };
  }

  /** The user amended a pending proposal → re-propose with the corrected fields (still pending). */
  private async revise(
    state: TurnState,
    pendingMessage: Awaited<ReturnType<typeof messageRepository.findPendingRunnerProposal>>,
    ids: { projectId: string; deviceId: string; workspaceId: string; harness: string },
    prompt: string,
    modelReply: string,
  ): Promise<RunnerIntentOutcome | null> {
    const current = pendingMessage?.proposedRunnerSession;
    if (pendingMessage === undefined || current === null || current === undefined) {
      // Nothing to revise — treat it as a fresh request instead.
      return this.propose(state, ids, prompt, modelReply);
    }
    // Carry forward whatever the user did NOT change (an empty field from the model = unchanged). A new
    // project supersedes the old checkout; otherwise the old checkout (and its project) stand.
    const projectChanged = ids.projectId.trim().length > 0 && ids.projectId !== current.projectId;
    const next = {
      projectId: ids.projectId.trim().length > 0 ? ids.projectId : (current.projectId ?? ''),
      deviceId: ids.deviceId.trim().length > 0 ? ids.deviceId : projectChanged ? '' : current.deviceId,
      workspaceId: ids.workspaceId.trim().length > 0 ? ids.workspaceId : projectChanged ? '' : current.workspaceId,
      harness: ids.harness.trim().length > 0 ? ids.harness : current.harness,
    };
    const nextPrompt = prompt.trim().length > 0 ? prompt : current.prompt;

    const outcome = this.propose(state, next, nextPrompt, modelReply);
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
    const actor = await this.resolveActor(userId);
    if (typeof actor === 'string') return { started: false, reply: actor };
    try {
      // By device + checkout: the service looks the binding up itself, so the session row carries the
      // project even when the proposal predates projects.
      const session = await runnerSessionService.startSession(actor, {
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
          reply: this.startFailureReply(proposal.deviceName, session.error),
        };
      }

      // Remember which chat to relay this session's permission gates and result back to.
      await runnerChatRelayService.registerOrigin(session.id, {
        userId,
        conversationId,
        channel,
        deviceName: proposal.deviceName,
        workspaceName: proposal.workspaceName,
        projectName: session.projectName,
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
      // The user is told "something went wrong"; that phrasing is all they can act on, and it is not
      // something they can report usefully. This is the copy of the fault that has the cause in it.
      Sentry.captureException(error, {
        tags: { surface: 'runner_intent', step: 'start_session' },
        extra: { userId, deviceName: proposal.deviceName },
      });
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
    { orgId, userId }: OrgActor,
    pending: PendingRunnerPermission | null,
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
      await runnerSessionService.decidePermission(orgId, pending.sessionId, pending.promptId, optionId);
      await runnerChatRelayService.clearPermission(pending.sessionId);
      const fallback = allow ? 'Approved — carrying on.' : 'Denied — I told it not to.';
      return { reply: modelReply.trim().length > 0 ? modelReply.trim() : fallback, proposal: null };
    } catch (error) {
      // A permission answer that never reached the session leaves an agent blocked on a prompt the user
      // believes they already answered. The reply guesses at "it may have already moved on"; this
      // records what actually happened.
      Sentry.captureException(error, {
        tags: { surface: 'runner_intent', step: 'permission_decision' },
        extra: { userId, sessionId: pending.sessionId, promptId: pending.promptId },
      });
      logger.warn('runner-intent permission decision failed', { err: String(error), userId });
      return {
        reply: 'I couldn\'t deliver that answer to the session — it may have already moved on.',
        proposal: null,
      };
    }
  }

  /** Push the most recent finished-with-branch session's branch to its remote. */
  private async push(
    { orgId }: OrgActor,
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
      const { remoteUrl } = await runnerSessionService.pushSession(orgId, target.id);
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
    { orgId }: OrgActor,
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
      const { prUrl } = await runnerSessionService.openPr(orgId, target.id, title, body);
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
    { orgId }: OrgActor,
    sessions: readonly RunnerSession[],
    modelReply: string,
  ): Promise<RunnerIntentOutcome | null> {
    const target = sessions.find((s) => s.endedAt === null);
    if (target === undefined) {
      return { reply: 'You don\'t have a running session to stop.', proposal: null };
    }
    try {
      await runnerSessionService.cancel(orgId, target.id);
      return {
        reply: modelReply.trim().length > 0 ? modelReply.trim() : `Stopping the session on ${target.deviceName}.`,
        proposal: null,
      };
    } catch (error) {
      return { reply: `I couldn't stop that session: ${this.errText(error)}`, proposal: null };
    }
  }

  // ── read-only answers: on WhatsApp these ARE the fleet page ─────────────────────────────────────────

  /** "What's running?" — the live sessions, then the most recent finished ones. */
  private describeSessions(sessions: readonly RunnerSession[]): string {
    const running = sessions.filter((s) => s.endedAt === null);
    const finished = sessions.filter((s) => s.endedAt !== null).slice(0, 3);
    const lines: string[] = [];
    if (running.length === 0) {
      lines.push('Nothing is running right now.');
    } else {
      lines.push(running.length === 1 ? 'One session running:' : `${running.length} sessions running:`);
      for (const s of running) lines.push(`• ${this.sessionLine(s)}`);
    }
    if (finished.length > 0) {
      lines.push('Recently finished:');
      for (const s of finished) lines.push(`• ${this.sessionLine(s)}`);
    }
    return lines.join('\n');
  }

  private sessionLine(s: RunnerSession): string {
    const what = s.projectName ?? s.workspaceName;
    const firstLine = s.prompt.split('\n')[0] ?? s.prompt;
    const instruction = firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
    const tail =
      s.endedAt === null
        ? s.status
        : s.prUrl !== null
          ? `${s.status}, PR ${s.prUrl}`
          : s.branch !== null
            ? `${s.status}, on ${s.branch}${s.pushed ? ' (pushed)' : ''}`
            : s.status;
    return `${what} on ${s.deviceName} — "${instruction}" — ${tail}`;
  }

  /** "Is the Mac mini up?" — every machine in the org, in one line each. */
  private describeDevices(state: TurnState): string {
    if (state.devices.length === 0) return 'There are no machines paired to this organization yet.';
    const lines = state.devices.map((d) => {
      const ready = state.projects
        .filter((p) => this.readyOn(state, p).some((c) => c.device.id === d.id))
        .map((p) => p.name);
      const status = d.online
        ? 'online'
        : d.kind === 'hosted'
          ? 'asleep (wakes when needed)'
          : d.lastSeenAt !== null
            ? `offline since ${new Date(d.lastSeenAt).toLocaleString('en-GB')}`
            : 'never connected';
      const projects = ready.length > 0 ? `; ready: ${ready.join(', ')}` : '';
      return `• ${d.name} (${d.environment}) — ${status}${projects}`;
    });
    return lines.join('\n');
  }

  // ── helpers ──────────────────────────────────────────────────────────────────────────────────────────

  /** The machines a project is READY on: bound, reachable, and the checkout is in the machine's live hello. */
  private readyOn(
    state: TurnState,
    project: Project,
  ): ReadonlyArray<{ device: RunnerDevice; workspace: RunnerDevice['workspaces'][number] }> {
    const out: Array<{ device: RunnerDevice; workspace: RunnerDevice['workspaces'][number] }> = [];
    for (const b of state.bindings.filter((x) => x.projectId === project.id)) {
      const device = state.online.find((d) => d.id === b.deviceId);
      const workspace = device?.workspaces.find((w) => w.id === b.workspaceId);
      if (device !== undefined && workspace !== undefined) out.push({ device, workspace });
    }
    return out;
  }

  /**
   * Resolve the model's chosen ids against LIVE state — the model's output is untrusted, so a project,
   * device, workspace or harness it names must actually exist and be runnable before a proposal is
   * built. Returns the resolved target, or the clarifying sentence to send when it cannot be pinned
   * down. Order: named machine → machines the project is ready on → exactly one, use it → two or more,
   * ASK. Zero gets a sentence for its cause, never a generic one.
   */
  private resolve(
    state: TurnState,
    ids: { projectId: string; deviceId: string; workspaceId: string; harness: string },
  ): ResolvedTarget | string {
    const project = state.projects.find((p) => p.id === ids.projectId) ?? null;

    let device: RunnerDevice | undefined;
    let workspace: RunnerDevice['workspaces'][number] | undefined;

    if (project !== null) {
      const ready = this.readyOn(state, project);
      if (ids.deviceId.trim().length > 0) {
        const named = ready.find((c) => c.device.id === ids.deviceId);
        if (named === undefined) {
          const deviceName = state.devices.find((d) => d.id === ids.deviceId)?.name ?? 'that machine';
          return this.notReadyReason(state, project, deviceName, ids.deviceId);
        }
        device = named.device;
        workspace = named.workspace;
      } else if (ready.length === 1 && ready[0] !== undefined) {
        device = ready[0].device;
        workspace = ready[0].workspace;
      } else if (ready.length > 1) {
        const names = ready.map((c) => c.device.name).join(' or ');
        return `${project.name} is ready on more than one machine — ${names}. Which one?`;
      } else {
        return this.notReadyReason(state, project, null, null);
      }
    } else {
      // No project named: a raw checkout on a named machine. Nothing is defaulted — a machine must be
      // named (or be the only one online), and the checkout must be named.
      device = state.online.find((d) => d.id === ids.deviceId) ?? (state.online.length === 1 ? state.online[0] : undefined);
      if (device === undefined) {
        const names = state.online.map((d) => d.name).join(', ');
        return state.projects.length > 0
          ? `Which project — ${state.projects.map((p) => p.name).join(', ')}? Or name a machine: ${names}.`
          : `Which machine should I use — ${names}?`;
      }
      workspace = device.workspaces.find((w) => w.id === ids.workspaceId);
      if (workspace === undefined) {
        const names = device.workspaces.map((w) => w.name).join(', ');
        return names.length > 0
          ? `Which checkout on ${device.name} — ${names}?`
          : `${device.name} has no checkouts exposed to run against.`;
      }
    }

    const harnessId = this.asHarnessId(ids.harness);
    const usable = device.harnesses.filter((h) => h.available);
    const preferred = harnessId !== null && usable.some((h) => h.id === harnessId) ? harnessId : undefined;
    const chosenHarness = preferred ?? usable[0]?.id;
    if (chosenHarness === undefined) {
      return `${device.name} doesn't have a coding agent available right now.`;
    }

    // The checkout's own binding decides the project when none was named.
    const boundProject =
      project ??
      state.projects.find((p) =>
        state.bindings.some((b) => b.projectId === p.id && b.deviceId === device.id && b.workspaceId === workspace.id),
      ) ??
      null;

    return { device, workspace, harness: chosenHarness, project: boundProject };
  }

  /** Why a project cannot run (on a given machine, or anywhere): one specific sentence per cause. */
  private notReadyReason(state: TurnState, project: Project, deviceName: string | null, deviceId: string | null): string {
    const bindings = state.bindings.filter((b) => b.projectId === project.id && (deviceId === null || b.deviceId === deviceId));
    if (bindings.length === 0) {
      return deviceName === null
        ? `${project.name} isn't bound to a checkout on any machine yet — bind it on the Fleet page first.`
        : `${project.name} isn't bound to a checkout on ${deviceName} — bind it on the Fleet page first.`;
    }
    const offline = bindings.filter((b) => !state.online.some((d) => d.id === b.deviceId));
    const notReporting = bindings.filter((b) => {
      const d = state.online.find((x) => x.id === b.deviceId);
      return d !== undefined && !d.workspaces.some((w) => w.id === b.workspaceId);
    });
    const nameOf = (id: string): string => state.devices.find((d) => d.id === id)?.name ?? 'a machine';
    if (notReporting.length > 0) {
      const b = notReporting[0];
      if (b !== undefined) {
        return `${nameOf(b.deviceId)} is online but isn't reporting ${b.workspacePath} — check the volume is mounted, then press Rescan on the Fleet page.`;
      }
    }
    if (offline.length > 0) {
      const names = offline.map((b) => nameOf(b.deviceId)).join(' and ');
      return `${project.name} is on ${names}, which ${offline.length === 1 ? 'is' : 'are'} offline right now.`;
    }
    return `${project.name} isn't ready to run right now.`;
  }

  /**
   * A start failure, said in words. The session row carries a machine-readable reason (it has to — the
   * UI and the API both read it), and relaying that verbatim into a chat is how a user ends up reading
   * "runner_wake_timeout" from an assistant. The known reasons get a sentence; anything else is passed
   * through rather than swallowed, because an unexplained failure is worse than an ugly one.
   */
  private startFailureReply(deviceName: string, error: string | null): string {
    if (error === 'runner_wake_timeout') {
      return `Your cloud runner didn't finish starting up in time. Try again in a moment — it usually only takes a minute.`;
    }
    if (error === 'device_offline') {
      return `${deviceName} isn't reachable right now — is the runner running on that machine?`;
    }
    return `I couldn't start it on ${deviceName}${error !== null && error.length > 0 ? `: ${error}` : '.'}`;
  }

  private asHarnessId(value: string): RunnerHarnessId | null {
    return RUNNER_HARNESS_IDS.find((id) => id === value) ?? null;
  }

  /** A compact, id-bearing snapshot of the live runner state for the classifier to choose from. Projects first. */
  private buildContext(
    state: TurnState,
    pendingProposal: ProposedRunnerSession | null,
    pendingPermission: PendingRunnerPermission | null,
  ): string {
    const lines: string[] = [];

    if (state.projects.length === 0) {
      lines.push('Projects: none defined yet.');
    } else {
      lines.push('Projects:');
      for (const p of state.projects) {
        const aliases = p.aliases.length > 0 ? `; aliases: ${p.aliases.join(', ')}` : '';
        const ready = this.readyOn(state, p);
        const where =
          ready.length === 0
            ? 'not ready on any machine right now'
            : `ready on ${ready.map((c) => `${c.device.name} [deviceId=${c.device.id} workspaceId=${c.workspace.id}]`).join(', ')}`;
        lines.push(`- ${p.name} [projectId=${p.id}] (repo ${p.repoName}${aliases}): ${where}`);
      }
    }

    if (state.online.length === 0) {
      lines.push('Available machines: none.');
    } else {
      lines.push('Available machines:');
      for (const d of state.online) {
        // fallback-ok (both): this is prose being rendered for the model. An empty list genuinely
        // IS "none" here — nothing failed, and no caller branches on the string.
        const harnesses = d.harnesses.filter((h) => h.available).map((h) => h.id).join(', ') || 'none'; // fallback-ok
        const workspaces = d.workspaces.map((w) => `${w.name} [id=${w.id}]`).join(', ') || 'none'; // fallback-ok
        // A sleeping cloud runner is still a valid target — the classifier must not rule it out, and the
        // user should hear that starting one takes a moment rather than that their runner is broken.
        const state2 = d.online ? '' : ' — asleep, wakes automatically (takes about a minute)';
        lines.push(
          `- ${d.name} [deviceId=${d.id}] (${d.os}, ${d.environment})${state2}; harnesses: ${harnesses}; checkouts: ${workspaces}`,
        );
      }
    }

    if (pendingProposal !== null) {
      lines.push(
        `Proposal awaiting confirmation: run "${pendingProposal.prompt}" with ${pendingProposal.harness} ` +
          `on ${pendingProposal.projectName ?? pendingProposal.workspaceName} (${pendingProposal.deviceName}).`,
      );
    } else {
      lines.push('Proposal awaiting confirmation: none.');
    }

    if (pendingPermission !== null) {
      lines.push(`Permission awaiting an answer: "${pendingPermission.title}".`);
    } else {
      lines.push('Permission awaiting an answer: none.');
    }

    const running = state.sessions.filter((s) => s.endedAt === null);
    const finishedWithBranch = state.sessions.filter((s) => s.endedAt !== null && s.branch !== null);
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
