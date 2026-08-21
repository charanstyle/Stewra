/**
 * The `/runner` Socket.IO namespace: the wire between a Stewra Runner (running on the USER'S own machine —
 * a laptop today, a cloud VM they own tomorrow) and Stewra's servers.
 *
 * A runner is NOT a user client, and — like the `/bridge` namespace — it gets its own namespace rather
 * than a role on the main one. It must never join a chat room, appear in presence, or receive another
 * user's traffic; giving it a socket with no access to any of that in the first place is cheaper and safer
 * than a shared socket guarded by checks somebody must remember to write.
 *
 * What a runner DOES is host coding agents (Claude Code, Codex, Gemini CLI) as local subprocesses and run
 * them against the user's own repositories. Everything below is therefore either a REPORT from the user's
 * machine (what a session is doing) or an INSTRUCTION to it (start a session, answer a permission prompt) —
 * never an agent action performed by us. The agent runs on their box, under their logins, on their files.
 *
 * Why separate from `/bridge`: a bridge relays WhatsApp; a runner executes code. They share the device-
 * token trust model and the outbound-socket transport, but nothing about their payloads, and conflating
 * them would let a bug in one reach the other.
 *
 * Naming note: `Request`/`Response` suffixes are reserved for REST contracts under `src/api/`. Realtime
 * payloads use the `Payload`/`Ack` suffix (matching `bridge.ts`) — hence `RunnerPermissionPromptPayload`,
 * not `...RequestPayload`, even though its wire event is `runner:permission-request`.
 */

/** The coding harnesses a runner can host. The runner reports which are actually installed via `hello`. */
export const RUNNER_HARNESS_IDS = ['claude-code', 'codex', 'gemini-cli'] as const;
export type RunnerHarnessId = (typeof RUNNER_HARNESS_IDS)[number];

/** One accepted shape of a pasted provider login: the literal it starts with, and how to describe it. */
export interface RunnerCredentialForm {
  /** The literal prefix the credential must start with, e.g. `sk-ant-oat`. */
  readonly prefix: string;
  /** How to name this form to the person who pasted it, e.g. "a long-lived OAuth token". */
  readonly label: string;
}

/**
 * The two logins the `claude` CLI accepts.
 *
 * These are not interchangeable: the CLI reads them from DIFFERENT environment variables, so the form
 * decides where the value has to go. The runner does that routing (`runner/src/core/harnessCommand.ts`);
 * this list is the single source of truth both it and the API boundary read, so a new accepted form
 * cannot be added in one place and silently rejected in the other.
 */
export const CLAUDE_CODE_CREDENTIAL_FORMS: readonly RunnerCredentialForm[] = [
  { prefix: 'sk-ant-oat', label: 'a long-lived OAuth token from `claude setup-token`' },
  { prefix: 'sk-ant-api', label: 'an Anthropic API key from the Anthropic Console' },
];

/**
 * Accepted credential forms per harness.
 *
 * A harness is absent when its credential has no prefix we can check for. That is deliberate rather
 * than a gap to fill in later: asserting a shape we are not sure of would reject the user's VALID key
 * at the paste field, which is a worse failure than accepting a malformed one and surfacing it at
 * session start. Only forms that are documented and stable belong here.
 */
export const RUNNER_CREDENTIAL_FORMS: Partial<Record<RunnerHarnessId, readonly RunnerCredentialForm[]>> = {
  'claude-code': CLAUDE_CODE_CREDENTIAL_FORMS,
};

/**
 * Why this pasted credential is unusable, or `null` when it looks well-formed.
 *
 * Checked at the API boundary so a bad paste is a 400 while the user is still looking at the field,
 * instead of an authentication error inside a container minutes later — by which point the message the
 * user sees comes from the CLI and says nothing about the paste that caused it.
 *
 * This validates FORM only. Whether the credential actually authenticates is not knowable here, and
 * a `null` return must never be read as "this login works".
 */
export function runnerCredentialProblem(harness: RunnerHarnessId, secret: string): string | null {
  if (secret !== secret.trim()) {
    return 'The credential has leading or trailing whitespace — copy it again without the surrounding spaces or newline.';
  }
  if (/\s/.test(secret)) {
    return 'The credential contains a space or line break, so it was not copied whole. Paste the entire value on one line.';
  }

  const forms = RUNNER_CREDENTIAL_FORMS[harness];
  if (forms === undefined) return null;
  if (forms.some((form) => secret.startsWith(form.prefix))) return null;

  const expected = forms.map((form) => `${form.label} (starts with "${form.prefix}")`).join(', or ');
  return `That does not look like a ${harness} login: expected ${expected}.`;
}

/**
 * Where a runner actually lives.
 *
 * 'local'  — a process on the user's OWN machine, paired with a single-use code. Stewra can start
 *            nothing on it; it dials out, and its git credentials are the machine's own.
 * 'hosted' — a container Stewra provisioned and can start, stop, and destroy. This is the cloud-first
 *            default path: no install, and Stewra mints the short-lived git credentials it needs.
 *
 * This is not a cosmetic label. The git-credential endpoint hands out a GitHub installation token ONLY
 * to a hosted device — giving one to a laptop would put a Stewra-minted credential on a machine Stewra
 * does not control.
 */
export const RUNNER_DEVICE_KINDS = ['local', 'hosted'] as const;
export type RunnerDeviceKind = (typeof RUNNER_DEVICE_KINDS)[number];

/**
 * What a machine is FOR, as labelled by the user in the fleet UI. The label is a gate, not a note: a
 * session on a `production` machine requires a typed confirmation before it starts, because the
 * alternative is a label that means nothing. Every device starts as `development`; promoting one is a
 * deliberate act on its row.
 */
export const RUNNER_ENVIRONMENTS = ['development', 'production'] as const;
export type RunnerEnvironment = (typeof RUNNER_ENVIRONMENTS)[number];

/**
 * What Stewra last saw of a hosted runner's container. Advisory, not authoritative — Docker (through
 * the provisioner) is the truth, and an hourly reconcile corrects drift such as a host reboot.
 *
 * 'provisioning' is the brief window where the row exists but the container does not yet; a row stuck
 * there is a failed provision that rollback did not reach, which reconcile cleans up.
 */
export const RUNNER_CONTAINER_STATUSES = [
  'provisioning',
  'starting',
  'running',
  'stopped',
  'failed',
] as const;
export type RunnerContainerStatus = (typeof RUNNER_CONTAINER_STATUSES)[number];

/** The lifecycle states a runner session moves through, as seen by the server and the UI. */
export const RUNNER_SESSION_STATUSES = [
  'starting',
  'running',
  'awaiting-permission',
  'completed',
  'failed',
  'cancelled',
] as const;
export type RunnerSessionStatus = (typeof RUNNER_SESSION_STATUSES)[number];

/** The kinds of streamed update a running session emits — a superset mapped from ACP session updates. */
export const RUNNER_UPDATE_KINDS = [
  /** A chunk of the agent's user-facing message. */
  'agent-message',
  /** The agent's reasoning/plan, when the harness exposes it separately from its message. */
  'agent-thought',
  /** The agent invoked a tool (shell, edit, read). `tool` carries the name; `text` a short description. */
  'tool-call',
  /** A tool returned. `text` is a bounded preview of the result. */
  'tool-result',
  /** A file diff the agent produced, as a unified-diff string in `text`. */
  'diff',
  /** A human-readable status line (e.g. "cloning repo", "created worktree"). */
  'status',
] as const;
export type RunnerUpdateKind = (typeof RUNNER_UPDATE_KINDS)[number];

/** Events the RUNNER sends to the server. */
export const RUNNER_CLIENT_EVENTS = {
  /** First frame after connecting: identifies the build and reports capabilities (harnesses, workspaces). */
  HELLO: 'runner:hello',
  /** A streamed increment of a running session (message text, tool call, diff, status). */
  SESSION_UPDATE: 'runner:session-update',
  /** A session reached a terminal state. No further updates for that `sessionId` follow. */
  SESSION_DONE: 'runner:session-done',
  /**
   * The harness hit a permission gate (run this command / edit this file / etc.) and the session is
   * blocked until the user answers. The server relays this to a control surface and sends back a
   * `runner:permission-decision`.
   */
  PERMISSION_REQUEST: 'runner:permission-request',
} as const;
export type RunnerClientEvent = (typeof RUNNER_CLIENT_EVENTS)[keyof typeof RUNNER_CLIENT_EVENTS];

/** Events the SERVER sends to a runner. */
export const RUNNER_SERVER_EVENTS = {
  /** Start a new coding session on a chosen harness + workspace. Acked with whether it was accepted. */
  START_SESSION: 'runner:start-session',
  /** A follow-up user turn for an already-running session. */
  PROMPT: 'runner:prompt',
  /** The user's answer to a `runner:permission-request`. */
  PERMISSION_DECISION: 'runner:permission-decision',
  /** Stop a running session and tear down its subprocess + worktree. */
  CANCEL: 'runner:cancel',
  /**
   * Push a finished session's branch to its workspace remote. Acked with a `RunnerGitActionAck` (the pushed
   * ref + remote URL, or a machine-readable error) — the runner does the git work with the machine's own
   * credentials; the server never holds them.
   */
  PUSH: 'runner:push',
  /** Open a pull request for a finished session's (pushed) branch, via the machine's `gh`. Acked with the URL. */
  OPEN_PR: 'runner:open-pr',
  /** The user revoked THIS device. The runner must stop all sessions, wipe its token, and shut down. */
  REVOKED: 'runner:revoked',
  /**
   * This build is older than the newest published runner. NOTIFY-ONLY: the runner surfaces an upgrade
   * notice (stderr, and the web panel shows the same fact from REST) — it never downloads or replaces
   * its own binary. A binary that executes code on the user's machine self-replacing over a socket
   * instruction would be an update channel with the attack surface of remote code execution.
   */
  UPDATE_AVAILABLE: 'runner:update-available',
  /**
   * Re-scan the declared workspace roots and say `hello` again. Sent when a person presses Rescan on the
   * fleet page — typically after remounting the volume the checkouts live on — so the runner's reported
   * workspaces catch up without a restart. `hello` otherwise fires only on connect.
   */
  RESCAN: 'runner:rescan',
} as const;
export type RunnerServerEvent = (typeof RUNNER_SERVER_EVENTS)[keyof typeof RUNNER_SERVER_EVENTS];

/**
 * Events the server sends to a USER'S web/app client (on the MAIN namespace, not `/runner`) so a session
 * view can render live. These are the runner's reports, forwarded: the server relays a runner's
 * `session-update`/`session-done`/`permission-request` to the user watching that session. Distinct event
 * names (not the `/runner` ones) because they cross a different namespace to a different kind of client, and
 * a user client must never be confused for a runner.
 */
export const RUNNER_UI_EVENTS = {
  SESSION_UPDATE: 'runner-ui:session-update',
  SESSION_DONE: 'runner-ui:session-done',
  PERMISSION_REQUEST: 'runner-ui:permission-request',
} as const;
export type RunnerUiEvent = (typeof RUNNER_UI_EVENTS)[keyof typeof RUNNER_UI_EVENTS];

// ── Capability reporting (runner → server, in `hello`) ──────────────────────────────────────────────

/** One coding harness on the runner's machine, and whether it is actually runnable. */
export interface RunnerHarnessInfo {
  readonly id: RunnerHarnessId;
  /** False when the binary is absent or failed its version probe — the server won't offer it. */
  readonly available: boolean;
  /** e.g. the `claude --version` string, when available. */
  readonly version?: string;
}

/**
 * One repository the runner is willing to run sessions against.
 *
 * On a laptop these are local checkouts the user has exposed; in a cloud VM they are repos the runner can
 * `git clone`. The `path` is meaningful only to the runner — the server treats it as an opaque handle and
 * never dereferences it.
 */
export interface RunnerWorkspace {
  /** Stable id the server uses to address this workspace when starting a session. */
  readonly id: string;
  /** Human label shown in the picker (e.g. "stewra (work laptop)"). */
  readonly name: string;
  /** Absolute path on the runner's machine, or the intended clone target. Opaque to the server. */
  readonly path: string;
  /** The canonical remote, when known — lets the UI show where a PR would land. */
  readonly gitRemote?: string;
  /** The base branch new sessions branch a worktree from (e.g. `main`). */
  readonly defaultBranch?: string;
}

/** `runner:hello` — the runner announcing itself and everything it can do. */
export interface RunnerHelloPayload {
  readonly appVersion: string;
  /** `process.platform` (e.g. `darwin`, `linux`) — surfaced so the user can tell their machines apart. */
  readonly os: string;
  readonly harnesses: readonly RunnerHarnessInfo[];
  readonly workspaces: readonly RunnerWorkspace[];
}

/**
 * `runner:update-available` — sent right after a `hello` whose `appVersion` is older than the newest
 * published build. Notify-only (see the event's docblock): the user re-downloads from `downloadUrl`.
 */
export interface RunnerUpdateAvailablePayload {
  /** The newest published runner version (`a.b.c`). */
  readonly latestVersion: string;
  /** Where to get it — config-driven, never a hardcoded URL. */
  readonly downloadUrl: string;
}

// ── Session lifecycle (server → runner) ─────────────────────────────────────────────────────────────

/** `runner:start-session` — begin a coding session. `sessionId` is minted by the server. */
export interface RunnerStartSessionPayload {
  readonly sessionId: string;
  readonly harness: RunnerHarnessId;
  readonly workspaceId: string;
  /** The user's opening instruction to the agent. */
  readonly prompt: string;
}

/** The runner's ack to `runner:start-session`. */
export interface RunnerStartSessionAck {
  readonly accepted: boolean;
  /** Why the runner refused (unknown harness, unknown workspace, at capacity) — for a clean UI error. */
  readonly error?: string;
}

/** `runner:prompt` — a follow-up turn in an existing session. */
export interface RunnerPromptPayload {
  readonly sessionId: string;
  readonly text: string;
}

/** `runner:cancel` — stop a session. */
export interface RunnerCancelPayload {
  readonly sessionId: string;
}

// ── Session reporting (runner → server) ─────────────────────────────────────────────────────────────

/**
 * `runner:session-update` — one streamed increment of a running session.
 *
 * `seq` is monotonic per session so the server/UI can order and de-duplicate increments even if the
 * transport reorders them. `text` is bounded by the runner before sending (agent output can be enormous).
 */
export interface RunnerSessionUpdatePayload {
  readonly sessionId: string;
  readonly seq: number;
  readonly kind: RunnerUpdateKind;
  readonly text?: string;
  /** For `tool-call`/`tool-result`: the tool name (e.g. `bash`, `edit`, `read`). */
  readonly tool?: string;
}

/** `runner:session-done` — a session reached a terminal state. */
export interface RunnerSessionDonePayload {
  readonly sessionId: string;
  readonly status: Extract<RunnerSessionStatus, 'completed' | 'failed' | 'cancelled'>;
  /** A short final summary for the transcript, when the harness produced one. */
  readonly summary?: string;
  readonly error?: string;
  /**
   * The isolated branch the session's work lives on (`stewra/run/<id>`). Present once a worktree was cut —
   * so the control surface can offer push / open-PR after the run without inventing the ref itself.
   */
  readonly branch?: string;
  /** The branch's HEAD after the runner's auto-commit — the unambiguous tip of what the session produced. */
  readonly headSha?: string;
  /** Whether the runner made a commit on finish (false when the agent left no changes, or already committed). */
  readonly committed?: boolean;
}

// ── Git follow-through (server ↔ runner, on a FINISHED session) ──────────────────────────────────────

/**
 * `runner:push` — push a finished session's branch to its workspace remote. The runner uses the MACHINE'S
 * own git credentials (it is the user's box); the server never sees or stores them. Acked, not streamed,
 * because it's a discrete action whose result (the pushed ref) the UI needs immediately.
 */
export interface RunnerPushPayload {
  readonly sessionId: string;
}

/** `runner:open-pr` — open a pull request for a finished session's branch, via the machine's `gh`. Acked. */
export interface RunnerOpenPrPayload {
  readonly sessionId: string;
  readonly title: string;
  readonly body: string;
}

/**
 * The runner's ack to `runner:push` / `runner:open-pr`. `ok:false` carries a machine-readable `error`
 * (e.g. `no_remote`, `gh_missing`, `unknown_session`) so the control surface renders an honest, specific
 * message instead of a generic failure — the same discipline as the start-session ack.
 */
export interface RunnerGitActionAck {
  readonly ok: boolean;
  /** The branch the action operated on. */
  readonly branch?: string;
  /** The remote URL the branch was pushed to (push). */
  readonly remoteUrl?: string;
  /** The created pull request URL (open-pr). */
  readonly prUrl?: string;
  readonly error?: string;
}

// ── Permission gating (runner ↔ server) ─────────────────────────────────────────────────────────────

/**
 * The semantics of a permission choice, taken verbatim from ACP's `PermissionOption.kind`. The `_once`
 * variants authorise just this action; the `_always` variants also tell the harness to stop asking for
 * this kind of action for the rest of the session. A UI styles allow-vs-reject on the prefix and can offer
 * "always" as a distinct, more-deliberate button.
 */
export const RUNNER_PERMISSION_KINDS = [
  'allow_once',
  'allow_always',
  'reject_once',
  'reject_always',
] as const;
export type RunnerPermissionKind = (typeof RUNNER_PERMISSION_KINDS)[number];

/** One choice offered for a permission prompt. `id` (the ACP optionId) is echoed back in the decision. */
export interface RunnerPermissionOption {
  readonly id: string;
  readonly label: string;
  readonly kind: RunnerPermissionKind;
}

/**
 * `runner:permission-request` — the harness needs the user to authorise something before proceeding.
 * (Type is `...PromptPayload`, not `...RequestPayload`: `Request` suffixes are reserved for REST.)
 */
export interface RunnerPermissionPromptPayload {
  readonly sessionId: string;
  /** Unique per prompt within a session; echoed in the decision so late/duplicate answers are ignorable. */
  readonly promptId: string;
  readonly title: string;
  /** What is being requested, in detail (the command to run, the file to write). */
  readonly detail: string;
  readonly options: readonly RunnerPermissionOption[];
}

/** `runner:permission-decision` — the user's answer, relayed from a control surface back to the runner. */
export interface RunnerPermissionDecisionPayload {
  readonly sessionId: string;
  readonly promptId: string;
  /** The `id` of the chosen `RunnerPermissionOption`. */
  readonly optionId: string;
}
