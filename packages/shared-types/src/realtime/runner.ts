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
  /** The user revoked THIS device. The runner must stop all sessions, wipe its token, and shut down. */
  REVOKED: 'runner:revoked',
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
