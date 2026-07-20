import { randomUUID } from 'node:crypto';
import type {
  RunnerCancelPayload,
  RunnerGitActionAck,
  RunnerOpenPrPayload,
  RunnerPermissionDecisionPayload,
  RunnerPermissionPromptPayload,
  RunnerPromptPayload,
  RunnerPushPayload,
  RunnerSessionDonePayload,
  RunnerSessionUpdatePayload,
  RunnerStartSessionAck,
  RunnerStartSessionPayload,
  RunnerWorkspace,
} from '@stewra/shared-types';
import { AcpSession } from './acpClient.js';
import type { AcpPermissionPrompt, AcpUpdate } from './acpClient.js';
import { commitWorktree, createSessionWorktree, openPullRequest, pushWorktree, worktreeDiff } from './workspace.js';
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
  /** The workspace this session runs against — kept so git follow-through knows the remote's default base. */
  readonly workspace: RunnerWorkspace;
  /** The opening prompt, used to caption the auto-commit when the session finishes. */
  readonly prompt: string;
  seq: number;
  /** Permission prompts awaiting the user's answer, keyed by the promptId we minted. */
  readonly pending: Map<string, (optionId: string | null) => void>;
  /** True once a terminal state was emitted, so a late error can't double-report a done session. */
  finished: boolean;
}

/**
 * A session that has finished but whose worktree/branch we retain, so the user can push it or open a PR
 * afterwards. Bounded and evicted oldest-first: the branch (with its commit) lives in the repo's object
 * store regardless, so eviction only reclaims the checked-out directory, never the work.
 */
interface CompletedSession {
  readonly worktree: Worktree;
  readonly workspace: RunnerWorkspace;
  readonly headSha: string;
  pushed: boolean;
  prUrl?: string;
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
  /** Finished sessions whose worktree/branch we keep so the user can push / open a PR after the run. */
  private readonly completed = new Map<string, CompletedSession>();
  /** Cap on retained finished sessions; oldest evicted first (its branch survives, only the dir is freed). */
  private static readonly MAX_COMPLETED = 100;

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
      workspace,
      prompt: payload.prompt,
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
    const retained = [...this.completed.values()];
    this.completed.clear();
    // Reclaim the retained checkout dirs; the branches (and their commits) stay in each repo.
    await Promise.all(retained.map((c) => c.worktree.cleanup(false).catch(() => undefined)));
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
    // Commit the agent's work onto the session branch so it becomes a reviewable, pushable object — never
    // loose edits a later cleanup could drop. A commit failure must not turn a completed run into a failed
    // one; we fall back to the branch's current tip and still report done.
    let headSha = live.worktree.baseSha;
    let committed = false;
    try {
      const result = await commitWorktree(live.worktree, commitMessage(live.prompt));
      headSha = result.headSha;
      committed = result.committed;
      this.emit(sessionId, live, {
        kind: 'status',
        text: committed ? `committed ${headSha.slice(0, 10)} on ${live.worktree.branch}` : 'no changes to commit',
      });
    } catch (error) {
      this.emit(sessionId, live, { kind: 'status', text: `commit skipped: ${messageOf(error)}` });
    }

    this.retainCompleted(sessionId, live, headSha);
    this.finish(sessionId, live, {
      sessionId,
      status: 'completed',
      summary: `stopReason: ${stopReason}`,
      branch: live.worktree.branch,
      headSha,
      committed,
    });
    live.acp.dispose(); // keep the worktree for follow-through (push / PR); just stop the subprocess
  }

  /** Register a finished session for later push/PR, evicting the oldest to stay within the retention cap. */
  private retainCompleted(sessionId: string, live: LiveSession, headSha: string): void {
    this.completed.set(sessionId, { worktree: live.worktree, workspace: live.workspace, headSha, pushed: false });
    while (this.completed.size > SessionManager.MAX_COMPLETED) {
      const oldest = this.completed.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.completed.get(oldest);
      this.completed.delete(oldest);
      // Keep the branch (the work); reclaim only the checkout directory.
      void evicted?.worktree.cleanup(false).catch(() => undefined);
    }
  }

  /**
   * Push a finished session's branch to its workspace remote, using the MACHINE'S own git credentials.
   * Acked (not streamed) so the control surface learns the pushed ref — or a specific reason — immediately.
   */
  async push(payload: RunnerPushPayload): Promise<RunnerGitActionAck> {
    const done = this.completed.get(payload.sessionId);
    if (done === undefined) return { ok: false, error: 'unknown_session' };
    try {
      const result = await pushWorktree(done.worktree);
      done.pushed = true;
      return { ok: true, branch: result.ref, remoteUrl: result.remoteUrl };
    } catch (error) {
      return { ok: false, branch: done.worktree.branch, error: messageOf(error) };
    }
  }

  /** Open a PR for a finished session's branch (pushing it first if needed), via the machine's `gh`. Acked. */
  async openPr(payload: RunnerOpenPrPayload): Promise<RunnerGitActionAck> {
    const done = this.completed.get(payload.sessionId);
    if (done === undefined) return { ok: false, error: 'unknown_session' };
    try {
      if (!done.pushed) {
        await pushWorktree(done.worktree);
        done.pushed = true;
      }
      const base = done.workspace.defaultBranch;
      const pr = await openPullRequest(done.worktree, {
        title: payload.title,
        body: payload.body,
        ...(base !== undefined ? { base } : {}),
      });
      done.prUrl = pr.url;
      return { ok: true, branch: done.worktree.branch, prUrl: pr.url };
    } catch (error) {
      return { ok: false, branch: done.worktree.branch, error: messageOf(error) };
    }
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

/**
 * A concise, single-line commit subject derived from the session's opening prompt. Git commit subjects are
 * conventionally short, so we take the first line and bound it, with a stable prefix that marks the commit
 * as a runner's automated capture of a session's work.
 */
function commitMessage(prompt: string): string {
  const firstLine = prompt.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? 'session changes';
  const subject = firstLine.length > 68 ? `${firstLine.slice(0, 68)}…` : firstLine;
  return `Stewra runner: ${subject}`;
}
