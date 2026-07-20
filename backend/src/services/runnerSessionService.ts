import {
  RUNNER_UI_EVENTS,
} from '@stewra/shared-types';
import type {
  ListRunnerSessionsResponse,
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
  promptRunner,
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

  /** A session reached a terminal state: record it and tell the user. */
  async handleDone(userId: string, payload: RunnerSessionDonePayload): Promise<void> {
    await runnerSessionRepository.finish(userId, payload.sessionId, {
      status: payload.status,
      ...(payload.summary !== undefined ? { summary: payload.summary } : {}),
      ...(payload.error !== undefined ? { error: payload.error } : {}),
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

  /** Load a session that must exist, belong to the user, and not already be finished. */
  private async requireActive(userId: string, sessionId: string): Promise<RunnerSession> {
    const session = await runnerSessionRepository.get(userId, sessionId);
    if (session === null) throw new NotFoundError('That session does not exist');
    if (session.endedAt !== null) throw new ConflictError('That session has already ended');
    return session;
  }
}

export const runnerSessionService = new RunnerSessionService();
