import { randomUUID } from 'node:crypto';
import type {
  RunnerCancelPayload,
  RunnerPermissionDecisionPayload,
  RunnerPermissionPromptPayload,
  RunnerPromptPayload,
  RunnerSessionDonePayload,
  RunnerSessionUpdatePayload,
  RunnerStartSessionAck,
  RunnerStartSessionPayload,
  RunnerWorkspace,
} from '@stewra/shared-types';
import { AcpSession } from './acpClient.js';
import type { AcpPermissionPrompt, AcpUpdate } from './acpClient.js';
import { createSessionWorktree, worktreeDiff } from './workspace.js';
import type { Worktree } from './workspace.js';

/** How the manager reports a session's progress back up the socket. Injected so the manager stays testable. */
export interface SessionEmitter {
  update(payload: RunnerSessionUpdatePayload): void;
  done(payload: RunnerSessionDonePayload): void;
  permission(payload: RunnerPermissionPromptPayload): void;
}

/** Resolves a server-supplied workspace id to one of this runner's declared workspaces, or undefined. */
export type WorkspaceResolver = (workspaceId: string) => RunnerWorkspace | undefined;

/** A unified diff longer than this is truncated before it goes on the wire — agent diffs can be enormous. */
const MAX_DIFF_CHARS = 20_000;
/** Same bound for any single streamed text increment. */
const MAX_TEXT_CHARS = 8_000;

function bound(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

interface LiveSession {
  readonly acp: AcpSession;
  readonly worktree: Worktree;
  seq: number;
  /** Permission prompts awaiting the user's answer, keyed by the promptId we minted. */
  readonly pending: Map<string, (optionId: string | null) => void>;
  /** True once a terminal state was emitted, so a late error can't double-report a done session. */
  finished: boolean;
}

/**
 * Owns every coding session running on this machine.
 *
 * One `LiveSession` per server-minted sessionId: its own harness subprocess (via `AcpSession`) and its own
 * isolated git worktree, so multiple sessions run concurrently without touching each other or the user's
 * main checkout. The manager is deliberately transport-agnostic — it turns ACP callbacks into
 * `RunnerSessionUpdatePayload`/`...DonePayload`/`...PromptPayload` and hands them to an injected emitter;
 * the socket client owns the wire.
 */
export class SessionManager {
  private readonly sessions = new Map<string, LiveSession>();

  constructor(
    private readonly emitter: SessionEmitter,
    private readonly resolveWorkspace: WorkspaceResolver,
  ) {}

  /**
   * Begin a session: resolve the workspace, cut a worktree, launch the harness, and — once it's genuinely
   * running — ack acceptance and kick off the opening turn asynchronously (its output streams via the
   * emitter). A refusal returns `{ accepted: false, error }` with a machine-readable reason, never throws,
   * so the server can turn each failure into an honest, specific UI message.
   */
  async start(payload: RunnerStartSessionPayload): Promise<RunnerStartSessionAck> {
    if (this.sessions.has(payload.sessionId)) return { accepted: false, error: 'duplicate_session' };

    const workspace = this.resolveWorkspace(payload.workspaceId);
    if (workspace === undefined) return { accepted: false, error: 'unknown_workspace' };

    let worktree: Worktree;
    try {
      worktree = await createSessionWorktree(workspace.path, payload.sessionId, workspace.defaultBranch);
    } catch (error) {
      return { accepted: false, error: `worktree_failed: ${messageOf(error)}` };
    }

    const live: LiveSession = {
      acp: this.buildAcp(payload.sessionId, payload.harness, worktree),
      worktree,
      seq: 0,
      pending: new Map(),
      finished: false,
    };

    try {
      await live.acp.start();
    } catch (error) {
      await worktree.cleanup(true).catch(() => undefined);
      return { accepted: false, error: `harness_failed: ${messageOf(error)}` };
    }

    this.sessions.set(payload.sessionId, live);
    this.emit(payload.sessionId, live, { kind: 'status', text: `worktree ${worktree.branch}` });
    // The opening turn runs detached; its updates stream and its completion emits `session-done`.
    void this.runTurn(payload.sessionId, live, payload.prompt);
    return { accepted: true };
  }

  /** A follow-up turn in a session that's already running. No-op for an unknown/finished session. */
  async prompt(payload: RunnerPromptPayload): Promise<void> {
    const live = this.sessions.get(payload.sessionId);
    if (live === undefined || live.finished) return;
    await this.runTurn(payload.sessionId, live, payload.text);
  }

  /** The user's answer to a permission prompt — resolves the awaiting ACP request. */
  decide(payload: RunnerPermissionDecisionPayload): void {
    const live = this.sessions.get(payload.sessionId);
    const resolve = live?.pending.get(payload.promptId);
    if (resolve === undefined) return; // unknown/late/duplicate — safe to ignore
    live?.pending.delete(payload.promptId);
    resolve(payload.optionId);
  }

  /** Stop a session: cancel the turn, tear down the subprocess and worktree, and report it cancelled. */
  async cancel(payload: RunnerCancelPayload): Promise<void> {
    const live = this.sessions.get(payload.sessionId);
    if (live === undefined) return;
    await live.acp.cancel().catch(() => undefined);
    this.rejectPending(live);
    await this.teardown(payload.sessionId, live, true);
    this.finish(payload.sessionId, live, { sessionId: payload.sessionId, status: 'cancelled' });
  }

  /** Stop everything — used when the device is revoked or the runner is shutting down. */
  async disposeAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.cancel({ sessionId: id })));
  }

  private buildAcp(sessionId: string, harness: RunnerStartSessionPayload['harness'], worktree: Worktree): AcpSession {
    return new AcpSession(harness, worktree.path, {
      onUpdate: (update: AcpUpdate): void => {
        const live = this.sessions.get(sessionId);
        if (live !== undefined) this.emit(sessionId, live, update);
      },
      onPermission: (prompt: AcpPermissionPrompt): Promise<string | null> =>
        this.awaitPermission(sessionId, prompt),
    });
  }

  /** Run one prompt turn and translate its terminal stop reason into a `session-done` (unless cancelled). */
  private async runTurn(sessionId: string, live: LiveSession, text: string): Promise<void> {
    let stopReason: string;
    try {
      stopReason = await live.acp.prompt(text);
    } catch (error) {
      this.rejectPending(live);
      await this.teardown(sessionId, live, false);
      this.finish(sessionId, live, { sessionId, status: 'failed', error: messageOf(error) });
      return;
    }

    // A cancelled turn is finalised by cancel(), not here — avoid a double `session-done`.
    if (stopReason === 'cancelled') return;

    await this.emitFinalDiff(sessionId, live);
    this.finish(sessionId, live, { sessionId, status: 'completed', summary: `stopReason: ${stopReason}` });
    live.acp.dispose(); // keep the worktree for inspection / later follow-through; just stop the subprocess
  }

  /** Mint a promptId, emit the permission request, and return a promise the decision resolves. */
  private awaitPermission(sessionId: string, prompt: AcpPermissionPrompt): Promise<string | null> {
    const live = this.sessions.get(sessionId);
    if (live === undefined) return Promise.resolve(null);
    const promptId = randomUUID();
    return new Promise<string | null>((resolve) => {
      live.pending.set(promptId, resolve);
      const payload: RunnerPermissionPromptPayload = {
        sessionId,
        promptId,
        title: bound(prompt.title, 500),
        detail: bound(prompt.detail, 2_000),
        options: prompt.options.map((o) => ({ id: o.id, label: o.label, kind: o.kind })),
      };
      this.emitter.permission(payload);
    });
  }

  /** Turn an ACP update into a sequenced wire payload and emit it. */
  private emit(sessionId: string, live: LiveSession, update: AcpUpdate): void {
    live.seq += 1;
    const payload: RunnerSessionUpdatePayload = {
      sessionId,
      seq: live.seq,
      kind: update.kind,
      ...(update.text !== undefined ? { text: bound(update.text, MAX_TEXT_CHARS) } : {}),
      ...(update.tool !== undefined ? { tool: update.tool } : {}),
    };
    this.emitter.update(payload);
  }

  private async emitFinalDiff(sessionId: string, live: LiveSession): Promise<void> {
    try {
      const diff = await worktreeDiff(live.worktree);
      if (diff.trim().length > 0) this.emit(sessionId, live, { kind: 'diff', text: bound(diff, MAX_DIFF_CHARS) });
    } catch {
      // A diff we couldn't compute is not worth failing a completed session over.
    }
  }

  private finish(sessionId: string, live: LiveSession, payload: RunnerSessionDonePayload): void {
    if (live.finished) return;
    live.finished = true;
    this.sessions.delete(sessionId);
    this.emitter.done(payload);
  }

  private async teardown(_sessionId: string, live: LiveSession, removeWorktree: boolean): Promise<void> {
    live.acp.dispose();
    if (removeWorktree) await live.worktree.cleanup(true).catch(() => undefined);
  }

  private rejectPending(live: LiveSession): void {
    for (const resolve of live.pending.values()) resolve(null);
    live.pending.clear();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
