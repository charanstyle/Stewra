import {
  RUNNER_UI_EVENTS,
} from '@stewra/shared-types';
import type {
  ListRunnerSessionsResponse,
  OpenRunnerPrResponse,
  PushRunnerSessionResponse,
  RunnerPermissionPromptPayload,
  RunnerSession,
  RunnerSessionActionResponse,
  RunnerSessionDonePayload,
  RunnerSessionUpdatePayload,
  StartRunnerSessionRequest,
} from '@stewra/shared-types';
import { config } from '../config/unifiedConfig.js';
import { runnerSessionRepository } from '../repositories/runnerSessionRepository.js';
import { runnerService } from './runnerService.js';
import {
  cancelRunnerSession,
  decidePermissionOnRunner,
  openPrOnRunner,
  promptRunner,
  pushOnRunner,
  startSessionOnRunner,
} from '../websocket/runnerEmitter.js';
import { emitToUser } from '../websocket/emitter.js';
import { ConflictError, NotFoundError, ServiceUnavailableError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/**
 * The control plane for runner sessions.
 *
 * It is a ROUTER, never an executor: it decides a session onto a chosen machine, records its lifecycle, and
 * relays two streams of events across the two namespaces — a runner's reports (`/runner`, device token) out
 * to the user watching (main namespace, JWT), and the user's answers back to the runner. The agent itself
 * runs on the user's box; nothing here touches a repo or spawns a process.
 *
 * Every session id it hands a runner is a `runner_sessions` row id, and every write is scoped by `user_id`,
 * so a runner — code on someone else's machine — can only ever move its own owner's sessions, never reach
 * across accounts even with a forged id.
 */
class RunnerSessionService {
  private assertEnabled(): void {
    if (!config.runner.enabled) {
      throw new ServiceUnavailableError('The Stewra Runner feature is not available');
    }
  }

  /**
   * Start a session on a chosen device. Persists the session first (so a failure to reach the machine is
   * still a visible, recorded session, not a lost request), then dispatches to that one runner and reflects
   * its acceptance into the row's status. Always returns the session — its `status` tells the whole story
   * (running / failed-with-reason).
   */
  async startSession(userId: string, req: StartRunnerSessionRequest): Promise<RunnerSession> {
    this.assertEnabled();

    const { devices } = await runnerService.listDevices(userId);
    const device = devices.find((d) => d.id === req.deviceId);
    if (device === undefined) throw new NotFoundError('That runner device does not exist');

    const harnessOk = device.harnesses.some((h) => h.id === req.harness && h.available);
    if (!harnessOk) {
      throw new ConflictError(`That machine can't run "${req.harness}" right now`);
    }
    const workspace = device.workspaces.find((w) => w.id === req.workspaceId);
    if (workspace === undefined) throw new NotFoundError('That workspace is not on the chosen machine');

    const session = await runnerSessionRepository.create({
      userId,
      deviceId: device.id,
      deviceName: device.name,
      harness: req.harness,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      prompt: req.prompt,
      status: 'starting',
    });

    const ack = await startSessionOnRunner(userId, device.id, {
      sessionId: session.id,
      harness: req.harness,
      workspaceId: workspace.id,
      prompt: req.prompt,
    });

    if (ack === null) {
      await runnerSessionRepository.finish(userId, session.id, { status: 'failed', error: 'device_offline' });
    } else if (!ack.accepted) {
      await runnerSessionRepository.finish(userId, session.id, {
        status: 'failed',
        error: ack.error ?? 'refused',
      });
    } else {
      await runnerSessionRepository.setStatus(userId, session.id, 'running');
    }

    const fresh = await runnerSessionRepository.get(userId, session.id);
    if (fresh === null) throw new NotFoundError('session vanished after creation'); // unreachable in practice
    logger.info('runner: session start', { userId, deviceId: device.id, sessionId: session.id, status: fresh.status });
    return fresh;
  }

  // ── Runner → user relays (called by the /runner socket handler; userId is the runner's own owner) ────

  /** A streamed increment from a runner: forward it to the user watching that session. */
  handleUpdate(userId: string, payload: RunnerSessionUpdatePayload): void {
    emitToUser(userId, RUNNER_UI_EVENTS.SESSION_UPDATE, payload);
  }

  /** A runner hit a permission gate: mark the session blocked and forward the prompt to the user. */
  async handlePermissionRequest(userId: string, payload: RunnerPermissionPromptPayload): Promise<void> {
    await runnerSessionRepository.setStatus(userId, payload.sessionId, 'awaiting-permission');
    emitToUser(userId, RUNNER_UI_EVENTS.PERMISSION_REQUEST, payload);
  }

  /** A session reached a terminal state: record it (including the branch/tip it produced) and tell the user. */
  async handleDone(userId: string, payload: RunnerSessionDonePayload): Promise<void> {
    await runnerSessionRepository.finish(userId, payload.sessionId, {
      status: payload.status,
      ...(payload.summary !== undefined ? { summary: payload.summary } : {}),
      ...(payload.error !== undefined ? { error: payload.error } : {}),
      ...(payload.branch !== undefined ? { branch: payload.branch } : {}),
      ...(payload.headSha !== undefined ? { headSha: payload.headSha } : {}),
    });
    emitToUser(userId, RUNNER_UI_EVENTS.SESSION_DONE, payload);
  }

  // ── User → runner relays (called by REST controllers) ───────────────────────────────────────────────

  /** Send a follow-up prompt to a running session. */
  async prompt(userId: string, sessionId: string, text: string): Promise<RunnerSessionActionResponse> {
    this.assertEnabled();
    const session = await this.requireActive(userId, sessionId);
    const delivered = await promptRunner(userId, session.deviceId, { sessionId, text });
    if (delivered) await runnerSessionRepository.setStatus(userId, sessionId, 'running');
    return { ok: delivered };
  }

  /** Relay the user's permission answer back to the runner. */
  async decidePermission(
    userId: string,
    sessionId: string,
    promptId: string,
    optionId: string,
  ): Promise<RunnerSessionActionResponse> {
    this.assertEnabled();
    const session = await this.requireActive(userId, sessionId);
    const delivered = await decidePermissionOnRunner(userId, session.deviceId, { sessionId, promptId, optionId });
    if (delivered) await runnerSessionRepository.setStatus(userId, sessionId, 'running');
    return { ok: delivered };
  }

  /** Ask the runner to stop a session. The runner's `session-done` (cancelled) finalises the row. */
  async cancel(userId: string, sessionId: string): Promise<RunnerSessionActionResponse> {
    this.assertEnabled();
    const session = await this.requireActive(userId, sessionId);
    const delivered = await cancelRunnerSession(userId, session.deviceId, { sessionId });
    return { ok: delivered };
  }

  /** The user's sessions, newest first. */
  async listSessions(userId: string): Promise<ListRunnerSessionsResponse> {
    this.assertEnabled();
    const sessions = await runnerSessionRepository.listByUser(userId);
    return { sessions };
  }

  // ── Git follow-through (on a FINISHED session) ────────────────────────────────────────────────────────

  /**
   * Push a finished session's branch to its workspace remote. The runner does the git work with the
   * machine's own credentials; we relay the outcome and record that the branch is now pushed.
   */
  async pushSession(userId: string, sessionId: string): Promise<PushRunnerSessionResponse> {
    this.assertEnabled();
    const session = await this.requireFinishedWithBranch(userId, sessionId);

    const ack = await pushOnRunner(userId, session.deviceId, { sessionId });
    if (ack === null) throw new ServiceUnavailableError('That machine is offline');
    if (!ack.ok) throw new ConflictError(this.gitFailure('Push failed', ack.error));

    await runnerSessionRepository.markPushed(userId, sessionId);
    const fresh = await this.reload(userId, sessionId);
    logger.info('runner: session pushed', { userId, sessionId, deviceId: session.deviceId });
    return { session: fresh, remoteUrl: ack.remoteUrl ?? null };
  }

  /**
   * Open a pull request for a finished session's branch (the runner pushes it first if needed), via the
   * machine's `gh`. Records the PR URL against the session so the history links straight to it.
   */
  async openPr(userId: string, sessionId: string, title: string, body: string): Promise<OpenRunnerPrResponse> {
    this.assertEnabled();
    const session = await this.requireFinishedWithBranch(userId, sessionId);

    const ack = await openPrOnRunner(userId, session.deviceId, { sessionId, title, body });
    if (ack === null) throw new ServiceUnavailableError('That machine is offline');
    if (!ack.ok) throw new ConflictError(this.gitFailure('Opening the pull request failed', ack.error));
    if (ack.prUrl === undefined) throw new ConflictError('The runner did not return a pull request URL');

    await runnerSessionRepository.recordPr(userId, sessionId, ack.prUrl);
    const fresh = await this.reload(userId, sessionId);
    logger.info('runner: session PR opened', { userId, sessionId, deviceId: session.deviceId });
    return { session: fresh, prUrl: ack.prUrl };
  }

  /** Load a session that must exist, belong to the user, and not already be finished. */
  private async requireActive(userId: string, sessionId: string): Promise<RunnerSession> {
    const session = await runnerSessionRepository.get(userId, sessionId);
    if (session === null) throw new NotFoundError('That session does not exist');
    if (session.endedAt !== null) throw new ConflictError('That session has already ended');
    return session;
  }

  /** Load a FINISHED session that has an isolated branch — the precondition for any git follow-through. */
  private async requireFinishedWithBranch(userId: string, sessionId: string): Promise<RunnerSession> {
    const session = await runnerSessionRepository.get(userId, sessionId);
    if (session === null) throw new NotFoundError('That session does not exist');
    if (session.endedAt === null) throw new ConflictError('That session is still running');
    if (session.branch === null) throw new ConflictError('That session produced no branch to push');
    return session;
  }

  /** Re-read a session after a write, treating a vanished row as the unreachable error it is. */
  private async reload(userId: string, sessionId: string): Promise<RunnerSession> {
    const fresh = await runnerSessionRepository.get(userId, sessionId);
    if (fresh === null) throw new NotFoundError('That session does not exist');
    return fresh;
  }

  /** A machine-readable runner error → an honest, specific user message (bounded so it can't be a payload). */
  private gitFailure(prefix: string, error: string | undefined): string {
    return error !== undefined && error.length > 0 ? `${prefix}: ${error.slice(0, 200)}` : prefix;
  }
}

export const runnerSessionService = new RunnerSessionService();
