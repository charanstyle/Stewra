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
import { machineAccessService } from './machineAccessService.js';
import type { MachineAccessOutcome } from './machineAccessService.js';
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
import { errorInWords, lastSeenInWords, listInWords, statusInWords } from './runnerVoice.js';

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
  | 'request_machine_access'
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
 *
 * Every noun here is written with its plural and every verb with its participle, because the words that
 * were missing were exactly the ones people use: "which MACHINES do I have" and "what is RUNNING on the
 * Mac mini" both failed `\bmachine\b` / `\brun\b` and never reached the fleet at all. The ordinary agent
 * answered instead, and — having no fleet to look at — described one it made up. A turn that gets in
 * here still has to survive the classifier, which may answer "none"; letting one through costs a model
 * call, keeping one out costs the truth.
 */
const BASE_RUNNER_WORDS =
  /\b(run|runs|running|runner|laptops?|machines?|computers?|desktops?|mac ?minis?|macbooks?|repos?|repositor(y|ies)|workspaces?|projects?|sessions?|worktrees?|commits?|lint|tests?|test suite|claude|codex|gemini|push|pull requests?|prs?|branch(es)?|agents?|coding|(is|are) .* (up|online|offline))\b/i;

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
    /is set up on .+ — which would you like me to use\?$/.test(text) ||
    /^Which project is this for — .+\?/.test(text) ||
    /^Which machine would you like — .+\?$/.test(text) ||
    /^Which folder on .+ — .+\?$/.test(text)
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

/** A machine of the person's own that lives in one of their OTHER organizations. */
export interface MachineElsewhere {
  readonly deviceName: string;
  readonly orgName: string;
}

/**
 * The machine the person just named, when the org this conversation answers for does not have it but
 * another of their own organizations does.
 *
 * "What is running on the Mac mini right now" came back as "Nothing's running in QA Web A" — true, and
 * not an answer to the question, because the Mac mini is paired in Nurturing Lab Limited and nothing
 * said so. Only orgs the person is a member of are ever considered, so this tells them nothing they
 * cannot already see on their own Fleet page.
 */
export function machineNamedElsewhere(
  latestUserText: string,
  elsewhere: ReadonlyArray<MachineElsewhere>,
): MachineElsewhere | null {
  const hit = elsewhere.find((m) => userNamedDevice(latestUserText, m.deviceName));
  return hit === undefined ? null : hit;
}

/** The most recent Stewra line in the history, or null when the user has spoken only. */
export function lastAssistantTurn(history: ReadonlyArray<ConversationTurn>): string | null {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i];
    if (turn !== undefined && turn.role === 'assistant') return turn.content.trim();
  }
  return null;
}

/**
 * The user's words in the exchange that is still open: every user turn back to (not across) Stewra's
 * last line that was not a question. "run the linter on Sandbox" → "Which one?" → "on qa-macos" →
 * "What command?" → "npm run lint" is one request answered in three pieces, and a machine the person
 * named in the second piece is still theirs in the third. A statement from Stewra (a proposal, a result,
 * a refusal) closes the exchange, so a machine named for an earlier, finished request is never carried
 * into a new one — that would be the silent pick {@link userNamedDevice} exists to prevent.
 */
export function openExchangeUserText(
  history: ReadonlyArray<ConversationTurn>,
  latestUserText: string,
): string {
  const pieces = [latestUserText];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i];
    if (turn === undefined) continue;
    if (turn.role === 'assistant') {
      if (!turn.content.trim().endsWith('?')) break;
      continue;
    }
    pieces.push(turn.content);
  }
  return pieces.join('\n');
}

/** The sentence Stewra ends the offer with. One constant, so the offer and its recognizer cannot drift. */
export const MACHINE_ACCESS_OFFER = 'Would you like me to ask them for permission?';

/**
 * Was Stewra's last line the offer to ask another organization for sight of this computer? A bare "yes"
 * to it carries no runner word, no project name and answers no proposal, so without this it would never
 * reach the classifier and the offer would be one Stewra makes and cannot hear the answer to.
 */
export function isMachineAccessOffer(text: string | null): boolean {
  return text !== null && text.endsWith(MACHINE_ACCESS_OFFER);
}

/**
 * The cheap gate in front of the classifier. A turn reaches the model when it mentions the runner (a
 * generic word or one of the person's own project names), when something concrete awaits an answer (a
 * pending proposal or permission, so a bare "yes" means something), or when Stewra's previous line was
 * its own clarifying question — "on qa-macos" carries no runner word and no project name and is only
 * meaningful because of the "Which one?" before it. Without that last clause the answer fell through to
 * the ordinary agent, which had no idea what it was being told.
 */
export function turnReachesClassifier(params: {
  latestUserText: string;
  projects: ReadonlyArray<Project>;
  hasPendingProposal: boolean;
  hasPendingPermission: boolean;
  history: ReadonlyArray<ConversationTurn>;
}): boolean {
  const lastFromStewra = lastAssistantTurn(params.history);
  return (
    looksLikeRunnerIntent(params.latestUserText, params.projects) ||
    params.hasPendingProposal ||
    params.hasPendingPermission ||
    isClarifyingAsk(lastFromStewra) ||
    isMachineAccessOffer(lastFromStewra)
  );
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
    'request_machine_access',
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
  /**
   * For list_sessions / list_devices: the machine the user named, in THEIR OWN words. Unlike `deviceId`
   * this is not a choice and resolves to nothing — it exists so an answer can say "I don't have a
   * machine called Mac mini" instead of quietly reporting on every other machine. Checked against the
   * user's text before it is used, so the model cannot invent a machine that was never mentioned.
   */
  machineMention: z.string().default(''),
});

const SYSTEM_PROMPT = [
  'You are the runner-control router for Stewra. Stewra can host coding agents (Claude Code, Codex,',
  'Gemini CLI) on the USER\'S OWN machines and run them against their PROJECTS. Decide what the latest user',
  'message is doing with respect to that, given the live context you are handed (the projects and which',
  'machines have each one ready, the machines themselves, any proposal awaiting the user\'s yes/no, any',
  'permission a running session is blocked on, and any finished work).',
  '',
  'Respond with ONLY a JSON object — no prose, no code fences — of shape:',
  '{"intent": string, "projectId": string, "deviceId": string, "workspaceId": string, "harness": string, "prompt": string, "reply": string, "machineMention": string}',
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
  '  For BOTH list intents, if the user named a machine, copy that name into "machineMention" exactly as',
  '  they wrote it — even, and especially, when no such machine appears in the context. That is how the',
  '  answer can say the machine is not here instead of reporting on the others as if it were.',
  '- "request_machine_access": Stewra has said that the computer it runs on is paired to an organization',
  '  the user is not in, and offered to ask that organization for permission — and the user is SAYING YES',
  '  to that offer ("yes", "please do", "go ahead and ask them"). Only ever in answer to that offer; a',
  '  "yes" to anything else is not this.',
  '- "none": the message is not about the runner at all.',
  '',
  'Rules:',
  '- Every id MUST appear verbatim in the context. NEVER choose a machine the user did not name: if a',
  '  project is ready on several machines, leave deviceId empty — the caller asks the user which one.',
  '  If you cannot resolve a project from the context, still use "start_request" with projectId empty.',
  '- If there is a pending permission AND a pending proposal, a bare "yes"/"no" answers the PERMISSION',
  '  (a blocked session is the more urgent thing).',
  '- When Stewra\'s previous line was a CLARIFYING QUESTION about a run request that could not be pinned',
  '  down ("… is set up on A and B — which would you like me to use?", "Which project is this for — …?",',
  '  "Which machine would you like — …?", "Which folder on …?") and the user answers it ("the Mac mini",',
  '  "on the MacBook Pro", "Truetalk"), that is a',
  '  "start_request" — NOT confirm_proposal, because no proposal exists yet. Carry the task ("prompt"), the',
  '  project and anything else from the original ask in the recent conversation, and fill in the field the',
  '  user just answered (copy its id from the context). If instead they REPEAT the request without naming',
  '  a machine, leave deviceId empty again — guessing the machine they did not name is the one thing this',
  '  must never do; Stewra will simply ask again.',
  '- A message that itself states what to run and where ("start a session on Truetalk and fix the failing',
  '  test") is ALWAYS a "start_request", whatever Stewra said just before — even right after a proposal was',
  '  confirmed, declined or cancelled. "confirm_proposal" is only for bare assent to a proposal that is',
  '  still pending.',
  '- "reply": one or two short sentences in Stewra\'s voice. Stewra speaks like a superb executive',
  '  assistant: warm, calm, plain English, as if texting a busy person she respects. Lead with what will',
  '  happen (or what just happened), then the ONE thing needed from them, and stop. Never an id, a code,',
  '  a file path the user did not use, or a stack of parentheses. Never the words "session", "harness",',
  '  "runner", "workspace", "checkout" or "intent" — say "the work", "the coding agent", "the machine",',
  '  "the folder". For start_request/revise_proposal: restate the task in the user\'s own words, on the',
  '  PROJECT\'s name (never the repo folder), mention the machine and the agent only when the user chose',
  '  or changed them, and ask for a go-ahead ("Shall I go ahead?"). For the executed intents: a brief,',
  '  natural acknowledgement ("On it.", "Understood — I\'ll leave it."). Never claim something already',
  '  happened that has not.',
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
  /** The acting organization's name, so an answer about machines can say WHOSE machines it lists. */
  readonly orgName: string;
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
      !turnReachesClassifier({
        latestUserText,
        projects: everyProject,
        hasPendingProposal: pendingProposalMessage !== undefined,
        hasPendingPermission: pendingPermission !== null,
        history,
      })
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
          ...(isMachineAccessOffer(lastAssistantTurn(history))
            ? [
                'Note: Stewra\'s previous line offered to ask another organization for permission to see',
                'the computer it runs on. If the latest message accepts that offer, classify as',
                '"request_machine_access". If it declines, classify as "none".',
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
    // "The user's words" are the whole open exchange, not just this line: "on qa-macos" answered two
    // turns ago still counts while Stewra has only asked questions since.
    if (data.deviceId.trim().length > 0) {
      const device = state.devices.find((d) => d.id === data.deviceId);
      if (
        device === undefined ||
        !userNamedDevice(openExchangeUserText(history, latestUserText), device.name)
      ) {
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
        return {
          reply: await this.describeSessions(state, latestUserText, this.mentioned(data, latestUserText)),
          proposal: null,
        };
      case 'list_devices':
        return {
          reply: await this.describeDevices(state, latestUserText, this.mentioned(data, latestUserText)),
          proposal: null,
        };
      case 'request_machine_access':
        return { reply: await this.requestMachineAccess(state), proposal: null };
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
        return `Which organization is this for — ${names}? You can set a default in Stewra under Organizations ("Use this one when I text Stewra"), then just ask me again.`;
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
    const [bindings, { devices }, { sessions }, org] = await Promise.all([
      projectRepository.listBindingsForOrg(actor.orgId),
      runnerService.listDevices(actor.orgId),
      runnerSessionService.listSessions(actor.orgId),
      organizationRepository.findById(actor.orgId),
    ]);
    // The acting org was just resolved from a live membership, so a missing row is a broken install,
    // not a case to paper over with a placeholder name.
    if (org === null) throw new Error(`the acting organization ${actor.orgId} no longer exists`);
    // A cloud runner counts as available even when its container is stopped: starting it is Stewra's
    // job, and `startSession` wakes it. Only a machine of the user's own is genuinely unreachable when
    // offline — nothing here can turn a laptop on.
    const online = devices.filter((d) => d.online || d.kind === 'hosted');
    return { actor, orgName: org.name, projects, bindings, online, devices, sessions };
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
          "I don't have a machine to run that on just now. Start the Stewra runner on one of your computers, or set up a cloud runner in Stewra, and I'll take it from there.",
        proposal: null,
      };
    }
    if (prompt.trim().length === 0) {
      return { reply: 'Happy to — what would you like done?', proposal: null };
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
        : `Just to confirm: "${proposal.prompt}" on ${what}, using ${proposal.deviceName} with ${HARNESS_LABELS[proposal.harness]}. Shall I go ahead?`;
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
      return { reply: "There's nothing waiting on a go-ahead from you at the moment. Tell me what you'd like done and I'll set it up.", proposal: null };
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
        reply: `On it — ${proposal.projectName ?? proposal.workspaceName} is under way on ${proposal.deviceName}. I'll only message you if it needs a decision from you, and when it's finished.`,
      };
    } catch (error) {
      // The user is told "something went wrong"; that phrasing is all they can act on, and it is not
      // something they can report usefully. This is the copy of the fault that has the cause in it.
      Sentry.captureException(error, {
        tags: { surface: 'runner_intent', step: 'start_session' },
        extra: { userId, deviceName: proposal.deviceName },
      });
      logger.warn('runner-intent failed to start proposed session', { err: String(error), userId });
      return { started: false, reply: "I'm sorry — I couldn't get that started. Please ask me again in a moment." };
    }
  }

  /** The user called off a pending proposal → mark it cancelled. */
  private async decline(
    pendingMessage: Awaited<ReturnType<typeof messageRepository.findPendingRunnerProposal>>,
    modelReply: string,
  ): Promise<RunnerIntentOutcome | null> {
    const proposal = pendingMessage?.proposedRunnerSession;
    if (pendingMessage === undefined || proposal === null || proposal === undefined) {
      return { reply: "Nothing's pending, so there's nothing to call off. All clear.", proposal: null };
    }
    await messageRepository.updateProposedRunnerSession(pendingMessage.id, { ...proposal, status: 'cancelled' });
    return {
      reply: modelReply.trim().length > 0 ? modelReply.trim() : "Understood — I'll leave it.",
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
      return { reply: "There's nothing waiting for your OK right now.", proposal: null };
    }
    const optionId = allow ? pending.allowOptionId : pending.denyOptionId;
    if (optionId === null) {
      return { reply: "I'm afraid that isn't one of the choices it offered — you can answer it from the Fleet page.", proposal: null };
    }
    try {
      await runnerSessionService.decidePermission(orgId, pending.sessionId, pending.promptId, optionId);
      await runnerChatRelayService.clearPermission(pending.sessionId);
      const fallback = allow ? "Thank you — I've let it carry on." : "Understood — I've told it not to.";
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
        reply: "I'm sorry — that answer didn't reach it; it may have already moved on. The Fleet page will show where things stand.",
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
      return { reply: "There's no finished work waiting to be pushed.", proposal: null };
    }
    try {
      const { remoteUrl } = await runnerSessionService.pushSession(orgId, target.id);
      const where = remoteUrl ? ` is now on ${remoteUrl}` : ' has been pushed';
      return {
        reply: modelReply.trim().length > 0 ? modelReply.trim() : `Done — ${target.branch}${where}.`,
        proposal: null,
      };
    } catch (error) {
      return { reply: `I couldn't push that — ${errorInWords(this.errText(error))}.`, proposal: null };
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
      return { reply: "There's no finished work to open a pull request for yet.", proposal: null };
    }
    const firstLine = target.prompt.split('\n')[0];
    const title = firstLine !== undefined && firstLine.length > 0 ? firstLine.slice(0, 120) : 'Stewra runner session';
    const body = target.summary ?? target.prompt;
    try {
      const { prUrl } = await runnerSessionService.openPr(orgId, target.id, title, body);
      return {
        reply: modelReply.trim().length > 0 ? modelReply.trim() : `Done — the pull request is open: ${prUrl}`,
        proposal: null,
      };
    } catch (error) {
      return { reply: `I couldn't open the pull request — ${errorInWords(this.errText(error))}.`, proposal: null };
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
      return { reply: "Nothing's running at the moment, so there's nothing to stop.", proposal: null };
    }
    try {
      await runnerSessionService.cancel(orgId, target.id);
      return {
        reply: modelReply.trim().length > 0 ? modelReply.trim() : `Stopping the work on ${target.deviceName} now.`,
        proposal: null,
      };
    } catch (error) {
      return { reply: `I couldn't stop that — ${errorInWords(this.errText(error))}.`, proposal: null };
    }
  }

  // ── read-only answers: on WhatsApp these ARE the fleet page ─────────────────────────────────────────

  /**
   * "What's running?" — the live sessions, then the most recent finished ones.
   *
   * When the person named one of this org's machines, only that machine's work is reported; naming a
   * machine and being answered about every machine is how "what is running on the Mac mini" came back
   * as three sessions on someone else's runners. A machine this org does not have matches nothing, so
   * the answer falls back to the org — and says so by name, which is what lets the reader see they are
   * being told about a tenant that has never heard of the machine they asked about.
   */
  private async describeSessions(
    state: TurnState,
    latestUserText: string,
    mention: string,
  ): Promise<string> {
    const named = state.devices.filter((d) => userNamedDevice(latestUserText, d.name));
    const only = named[0];
    if (named.length === 1 && only !== undefined) {
      const mine = state.sessions.filter((s) => s.deviceId === only.id);
      return this.sessionReport(mine, `on ${only.name}`);
    }
    const caveat = named.length === 0 ? await this.machineCaveat(state, mention, latestUserText) : null;
    const report = this.sessionReport(state.sessions, `in ${state.orgName}`);
    return caveat === null ? report : `${caveat}\n${report}`;
  }

  /**
   * The machine the person asked about is not one this conversation can see. Say which, and why.
   *
   * Empty when they named no machine — a plain "what's running?" is about the whole org and needs no
   * caveat, and this is also what keeps the other-organizations lookup off every such turn.
   */
  private async machineCaveat(
    state: TurnState,
    mention: string,
    latestUserText: string,
  ): Promise<string | null> {
    if (mention.length === 0) return null;
    const elsewhere = await this.namedElsewhere(state, latestUserText);
    if (elsewhere !== null) return elsewhere;
    const here = await this.namedThisComputer(state, latestUserText);
    if (here !== null) return here;
    return `I don't have a machine called "${mention}" in ${state.orgName}.`;
  }

  /**
   * The machine the person named is the very computer Stewra is running on — and it belongs to somebody
   * else's organization.
   *
   * This is the case the flat "I don't have a machine called that" was worst at. It was true and it was
   * useless: the machine is right here, Stewra can prove it (the bridge and the runner report the same
   * host identity), and the only thing standing between the two is a permission nobody had a way to ask
   * for. So say what is actually true, and — when asking is available — offer to ask.
   *
   * Gated on the person's own words naming that machine. Their bridge is always on SOME computer, and
   * volunteering "by the way, this box belongs to Acme" on a turn about something else would be Stewra
   * telling them about a machine they never asked about.
   */
  private async namedThisComputer(state: TurnState, latestUserText: string): Promise<string | null> {
    const standing = await machineAccessService.inspectOwnMachine(state.actor.userId);
    if (standing.kind === 'host-unknown' || standing.kind === 'no-runner') return null;
    // `already-visible` means it is in one of their own orgs, which `namedElsewhere` has already said
    // better — it names the org this conversation answers for as well.
    if (standing.kind === 'already-visible') return null;
    if (!userNamedDevice(latestUserText, standing.deviceName)) return null;

    switch (standing.kind) {
      case 'granted':
        return `${standing.deviceName} is the computer I'm running on, and ${standing.orgName} has let you see it — but this conversation answers for ${state.orgName}, so switch there and I can tell you about it.`;
      case 'pending':
        return `${standing.deviceName} is the computer I'm running on, but it's paired to ${standing.orgName} — I've asked them for permission and they haven't answered yet.`;
      case 'denied':
        return `${standing.deviceName} is the computer I'm running on, but it's paired to ${standing.orgName}, and they turned down the request to let you see it.`;
      case 'can-ask':
        return `${standing.deviceName} is the computer I'm running on, but it's paired to ${standing.orgName} and I'm not in it, so I can't see what's on it. ${MACHINE_ACCESS_OFFER}`;
      default:
        // Unreachable today: the four kinds above are what is left after the guards. A new kind lands
        // here rather than silently borrowing one of these sentences.
        throw new Error(`unhandled machine-access outcome: ${JSON.stringify(standing)}`);
    }
  }

  /**
   * "Yes, ask them." Files the request against the owning org, where an admin decides it in the Stewra
   * app. Every other outcome is something that changed between the offer and the answer, and each gets
   * its own sentence rather than a cheerful "asked!" that did nothing.
   */
  private async requestMachineAccess(state: TurnState): Promise<string> {
    const outcome: MachineAccessOutcome = await machineAccessService.askForOwnMachine(state.actor.userId);
    switch (outcome.kind) {
      case 'asked':
        return `Done — I've asked ${outcome.orgName} to let you see ${outcome.deviceName}. Whoever runs that organization will find it in Stewra, and I'll be able to answer about this machine as soon as they say yes.`;
      case 'pending':
        return `That request is already with ${outcome.orgName} — they haven't answered it yet. I'll be able to see ${outcome.deviceName} the moment they do.`;
      case 'denied':
        return `${outcome.orgName} has already turned that down, so I won't ask again — someone there would need to approve it in Stewra.`;
      case 'granted':
        return `You already have it: ${outcome.orgName} has let you see ${outcome.deviceName}. This conversation answers for ${state.orgName} though, so switch organizations and ask me again.`;
      case 'already-visible':
        return `${outcome.deviceName} is already yours to see — no permission needed.`;
      case 'no-runner':
        return `There's nothing to ask for: no machine is paired to Stewra on ${outcome.hostname}. Install the Stewra runner there and pair it, and it's yours.`;
      case 'host-unknown':
        return "I can't tell which computer I'm running on, so I don't know who to ask. Updating Stewra Bridge to the current version is what fixes that.";
      case 'can-ask':
        // `askForOwnMachine` returns this only if the row vanished between its two reads.
        return 'Something changed while I was asking — try me again in a moment.';
    }
  }

  /**
   * The machine name the model says the user named, kept only when the user's own words contain it.
   * The model has been seen echoing a machine from the context that the person never mentioned, and an
   * answer built on that would be about a machine nobody asked about.
   */
  private mentioned(data: { machineMention: string }, latestUserText: string): string {
    const mention = data.machineMention.trim();
    if (mention.length === 0) return '';
    return normalizeName(latestUserText).includes(normalizeName(mention)) ? mention : '';
  }

  /**
   * The sentence for a machine the person named that this org does not have but another of THEIR OWN
   * organizations does.
   *
   * "What is running on the Mac mini right now" was answered with "Nothing's running in QA Web A" —
   * every word true and the question left unanswered, because the machine asked about was paired in a
   * different organization of the same person's and nothing said so. Only orgs this user is a member of
   * are consulted, so this reveals nothing they cannot already see on their own Fleet page.
   */
  private async namedElsewhere(state: TurnState, latestUserText: string): Promise<string | null> {
    const memberships = await organizationRepository.listForUser(state.actor.userId);
    const others: MachineElsewhere[] = [];
    for (const m of memberships) {
      if (m.org.id === state.actor.orgId) continue;
      const { devices } = await runnerService.listDevices(m.org.id);
      for (const d of devices) others.push({ deviceName: d.name, orgName: m.org.name });
    }
    const hit = machineNamedElsewhere(latestUserText, others);
    return hit === null
      ? null
      : `I can't see ${hit.deviceName} from here — it's paired in ${hit.orgName}, and this conversation answers for ${state.orgName}.`;
  }

  /** The sessions report itself. `scope` says what "nothing" is a statement about. */
  private sessionReport(sessions: readonly RunnerSession[], scope: string): string {
    const running = sessions.filter((s) => s.endedAt === null);
    const finished = sessions.filter((s) => s.endedAt !== null).slice(0, 3);
    const lines: string[] = [];
    if (running.length === 0) {
      lines.push(
        finished.length > 0
          ? `Nothing's running ${scope} at the moment.`
          : `Nothing's running ${scope} at the moment, and nothing has run yet.`,
      );
    } else {
      lines.push(
        running.length === 1
          ? `Here's what's running ${scope}:`
          : `Here's what's running ${scope} — ${running.length} things:`,
      );
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
    const state = statusInWords(s.status);
    const tail =
      s.endedAt === null
        ? state
        : s.prUrl !== null
          ? `${state}, pull request open: ${s.prUrl}`
          : s.branch !== null
            ? `${state}, ${s.pushed ? 'pushed' : 'ready to push'} (${s.branch})`
            : state;
    return `${what} on ${s.deviceName} — "${instruction}" — ${tail}`;
  }

  /** "Is the Mac mini up?" — every machine in the org, in one line each. */
  /**
   * The machines answer. It names the organization, always.
   *
   * Without that, "is the Mac mini up?" asked from an account whose org has no Mac mini came back as a
   * list of two other machines — every word true, the whole answer misleading, because the reader had
   * no way to see they were asking a tenant that has never heard of that machine. A machine paired in
   * ANOTHER of the person's organizations is invisible here by design; saying whose machines these are
   * is what makes that visible instead of silent.
   */
  private async describeDevices(
    state: TurnState,
    latestUserText: string,
    mention: string,
  ): Promise<string> {
    if (state.devices.length === 0) {
      return `No machines are connected to ${state.orgName} yet. Once the Stewra runner is running on one, it'll show up here.`;
    }
    // A machine the person named by name is the machine they asked about; the rest are noise.
    const named = state.devices.filter((d) => userNamedDevice(latestUserText, d.name));
    const shown = named.length > 0 ? named : state.devices;
    const caveat = named.length === 0 ? await this.machineCaveat(state, mention, latestUserText) : null;
    const heading =
      named.length > 0
        ? `In ${state.orgName}:`
        : caveat !== null
          ? `${caveat} Here's ${state.orgName}:`
          : `Machines in ${state.orgName} (anything paired in another of your organizations won't be here):`;
    const lines = shown.map((d) => {
      const ready = state.projects
        .filter((p) => this.readyOn(state, p).some((c) => c.device.id === d.id))
        .map((p) => p.name);
      const status = d.online
        ? 'online'
        : d.kind === 'hosted'
          ? 'asleep — wakes when needed'
          : d.lastSeenAt !== null
            ? `offline, last seen ${lastSeenInWords(d.lastSeenAt)}`
            : 'never connected';
      // The label is worth a word only when it carries weight: production means a typed confirmation.
      const label = d.environment === 'production' ? ' (production)' : '';
      const projects = ready.length > 0 ? `; ready for ${listInWords(ready)}` : '';
      return `• ${d.name}${label} — ${status}${projects}`;
    });
    return [heading, ...lines].join('\n');
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
        const names = listInWords(ready.map((c) => c.device.name));
        return `${project.name} is set up on ${names} — which would you like me to use?`;
      } else {
        return this.notReadyReason(state, project, null, null);
      }
    } else {
      // No project named: a raw checkout on a named machine. Nothing is defaulted — a machine must be
      // named (or be the only one online), and the checkout must be named.
      device = state.online.find((d) => d.id === ids.deviceId) ?? (state.online.length === 1 ? state.online[0] : undefined);
      if (device === undefined) {
        const machines = listInWords(state.online.map((d) => d.name), 'or');
        return state.projects.length > 0
          ? `Which project is this for — ${listInWords(state.projects.map((p) => p.name), 'or')}? Or just tell me the machine: ${machines}.`
          : `Which machine would you like — ${machines}?`;
      }
      workspace = device.workspaces.find((w) => w.id === ids.workspaceId);
      if (workspace === undefined) {
        const names = listInWords(device.workspaces.map((w) => w.name), 'or');
        return names.length > 0
          ? `Which folder on ${device.name} — ${names}?`
          : `${device.name} doesn't have any project folders I can work in yet.`;
      }
    }

    const harnessId = this.asHarnessId(ids.harness);
    const usable = device.harnesses.filter((h) => h.available);
    const preferred = harnessId !== null && usable.some((h) => h.id === harnessId) ? harnessId : undefined;
    const chosenHarness = preferred ?? usable[0]?.id;
    if (chosenHarness === undefined) {
      return `${device.name} doesn't have a coding agent installed that I can use, I'm afraid.`;
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
        ? `${project.name} isn't set up on any machine yet. Link it to its folder on the Fleet page and I'll be able to run it.`
        : `${project.name} isn't set up on ${deviceName} yet. Link it to its folder there on the Fleet page and I'll be able to run it.`;
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
        return `${nameOf(b.deviceId)} is online, but I can't see ${project.name}'s folder on it right now (${b.workspacePath}). Is the drive mounted? Once it is, press Rescan on the Fleet page and I'll try again.`;
      }
    }
    if (offline.length > 0) {
      const names = listInWords(offline.map((b) => nameOf(b.deviceId)));
      return `${project.name} lives on ${names}, which ${offline.length === 1 ? 'is' : 'are'} offline at the moment. I'll be able to run it as soon as it's back.`;
    }
    return `${project.name} isn't ready to run at the moment.`;
  }

  /**
   * A start failure, said in words. The session row carries a machine-readable reason (it has to — the
   * UI and the API both read it), and relaying that verbatim into a chat is how a user ends up reading
   * "runner_wake_timeout" from an assistant. The known reasons get a sentence; anything else is passed
   * through rather than swallowed, because an unexplained failure is worse than an ugly one.
   */
  private startFailureReply(deviceName: string, error: string | null): string {
    if (error === 'runner_wake_timeout') {
      return 'Your cloud runner is taking longer than usual to wake up. Give it a minute and ask me again.';
    }
    if (error === 'device_offline') {
      return `${deviceName} isn't reachable at the moment — is the Stewra runner still running there?`;
    }
    return `I couldn't start that on ${deviceName}${error !== null && error.length > 0 ? ` — ${errorInWords(error)}` : ''}.`;
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
