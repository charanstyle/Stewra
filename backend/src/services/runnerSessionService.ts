import { RUNNER_UI_EVENTS } from '@stewra/shared-types';
import type {
  ListRunnerSessionsResponse,
  OpenRunnerPrResponse,
  PushRunnerSessionResponse,
  RunnerDevice,
  RunnerHarnessId,
  RunnerPermissionPromptPayload,
  RunnerSession,
  RunnerSessionActionResponse,
  RunnerSessionDonePayload,
  RunnerSessionUpdatePayload,
  StartOrgRunnerSessionRequest,
  StartRunnerSessionRequest,
} from '@stewra/shared-types';
import { config } from '../config/unifiedConfig.js';
import { projectRepository } from '../repositories/projectRepository.js';
import { runnerSessionRepository } from '../repositories/runnerSessionRepository.js';
import { hostedRunnerService } from './hostedRunnerService.js';
import { runnerChatRelayService } from './runnerChatRelayService.js';
import { runnerService } from './runnerService.js';
import type { OrgActor } from './runnerService.js';
import {
  cancelRunnerSession,
  decidePermissionOnRunner,
  openPrOnRunner,
  promptRunner,
  pushOnRunner,
  startSessionOnRunner,
} from '../websocket/runnerEmitter.js';
import { emitToUser } from '../websocket/emitter.js';
import {
  ChoiceRequiredError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/** What a start needs once the target has been decided, however it was decided. */
interface Dispatch {
  readonly device: RunnerDevice;
  readonly harness: RunnerHarnessId;
  readonly workspaceId: string;
  readonly prompt: string;
  readonly projectId: string | null;
  readonly projectName: string | null;
}

/**
 * The control plane for runner sessions.
 *
 * It is a ROUTER, never an executor: it decides a session onto a chosen machine, records its lifecycle, and
 * relays two streams of events across the two namespaces — a runner's reports (`/runner`, device token) out
 * to the member watching (main namespace, JWT), and that member's answers back to the runner. The agent
 * itself runs on the org's box; nothing here touches a repo or spawns a process.
 *
 * TENANCY. A person acts on sessions through a required `orgId` (an `OrgActor`); a session's org is copied
 * from its device, never supplied by a client. A RUNNER's reports are scoped by the `deviceId` its socket
 * authenticated as, and are relayed to the `user_id` on the session row — the member who started it,
 * who need not be the person who paired the machine.
 */
class RunnerSessionService {
  private assertEnabled(): void {
    if (!config.runner.enabled) {
      throw new ServiceUnavailableError('The Stewra Runner feature is not available');
    }
  }

  /**
   * Start a session on a chosen device + workspace (the `/runner/sessions` shape). If that checkout is
   * bound to a project, the session records the project; an archived project refuses new sessions.
   */
  async startSession(actor: OrgActor, req: StartRunnerSessionRequest): Promise<RunnerSession> {
    this.assertEnabled();
    const device = await runnerService.requireDevice(actor.orgId, req.deviceId);
    this.assertWorkspace(device, req.workspaceId);

    const binding = await projectRepository.findBindingForWorkspace(actor.orgId, device.id, req.workspaceId);
    let projectId: string | null = null;
    let projectName: string | null = null;
    if (binding !== null) {
      const project = await projectRepository.get(actor.orgId, binding.projectId);
      if (project === null) throw new NotFoundError('The project bound to that workspace does not exist');
      if (project.archivedAt !== null) {
        throw new ConflictError(`"${project.name}" is archived and does not take new sessions`);
      }
      projectId = project.id;
      projectName = project.name;
    }

    return this.dispatch(actor, {
      device,
      harness: req.harness,
      workspaceId: req.workspaceId,
      prompt: req.prompt,
      projectId,
      projectName,
    });
  }

  /**
   * Start a session on a PROJECT (the `/orgs/:orgId/runner/sessions` shape). The server finds where the
   * project is bound. Zero bindings is a 409 with the cause; one is used; several without a named device
   * is a `CHOICE_REQUIRED` 409 listing them — it never picks, because "the online one" is behaviour that
   * changes with transient state.
   */
  async startOrgSession(actor: OrgActor, req: StartOrgRunnerSessionRequest): Promise<RunnerSession> {
    this.assertEnabled();
    const project = await projectRepository.get(actor.orgId, req.projectId);
    if (project === null) throw new NotFoundError('That project does not exist');
    if (project.archivedAt !== null) {
      throw new ConflictError(`"${project.name}" is archived and does not take new sessions`);
    }

    const bindings = await projectRepository.listBindingsForProject(actor.orgId, project.id);
    if (bindings.length === 0) {
      throw new ConflictError(`"${project.name}" is not bound to a checkout on any machine yet`);
    }

    let chosen = bindings[0];
    if (req.deviceId !== undefined) {
      chosen = bindings.find((b) => b.deviceId === req.deviceId);
      if (chosen === undefined) {
        throw new ConflictError(`"${project.name}" is not bound to a checkout on that machine`);
      }
    } else if (bindings.length > 1) {
      const { devices } = await runnerService.listDevices(actor.orgId);
      const nameOf = new Map(devices.map((d) => [d.id, d.name]));
      throw new ChoiceRequiredError(
        `"${project.name}" is on more than one machine — which one?`,
        bindings.map((b) => ({ field: b.deviceId, message: nameOf.get(b.deviceId) ?? b.deviceId })),
      );
    }
    if (chosen === undefined) throw new NotFoundError('binding vanished'); // unreachable: length > 0

    const device = await runnerService.requireDevice(actor.orgId, chosen.deviceId);
    this.assertWorkspace(device, chosen.workspaceId);
    return this.dispatch(actor, {
      device,
      harness: req.harness,
      workspaceId: chosen.workspaceId,
      prompt: req.prompt,
      projectId: project.id,
      projectName: project.name,
    });
  }

  /** The device must have reported this workspace in its last hello — the server never guesses a path. */
  private assertWorkspace(device: RunnerDevice, workspaceId: string): void {
    if (!device.workspaces.some((w) => w.id === workspaceId)) {
      throw new ConflictError(
        `${device.name} is not reporting that checkout — check the volume is mounted, then Rescan`,
      );
    }
  }

  /**
   * Persist the session first (so a failure to reach the machine is still a visible, recorded session, not
   * a lost request), then dispatch to that one runner and reflect its acceptance into the row's status.
   * Always returns the session — its `status` tells the whole story (running / failed-with-reason).
   */
  private async dispatch(actor: OrgActor, d: Dispatch): Promise<RunnerSession> {
    const { device } = d;
    const harnessOk = device.harnesses.some((h) => h.id === d.harness && h.available);
    if (!harnessOk) throw new ConflictError(`${device.name} can't run "${d.harness}" right now`);
    const workspace = device.workspaces.find((w) => w.id === d.workspaceId);
    if (workspace === undefined) throw new NotFoundError('That workspace is not on the chosen machine');

    const session = await runnerSessionRepository.create({
      orgId: actor.orgId,
      userId: actor.userId,
      deviceId: device.id,
      deviceName: device.name,
      projectId: d.projectId,
      projectName: d.projectName,
      harness: d.harness,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      prompt: d.prompt,
      status: 'starting',
    });

    // A hosted runner that is offline is not a problem to report — it is a container Stewra stopped to
    // save resources, and starting it is Stewra's job, not the user's. Waking happens AFTER the session
    // row exists so the wait is visible as a session in progress rather than a request that hangs.
    if (device.kind === 'hosted' && !device.online) {
      this.emitStatus(actor.userId, session.id, 'Waking your cloud runner…');
      const awake = await hostedRunnerService.wakeAndAwait(device.id);
      if (!awake) {
        await runnerSessionRepository.finish(actor.orgId, session.id, {
          status: 'failed',
          error: 'runner_wake_timeout',
        });
        logger.warn('runner: hosted runner did not wake in time', { deviceId: device.id, sessionId: session.id });
        return this.reload(actor.orgId, session.id);
      }
    }

    const ack = await startSessionOnRunner(device.id, {
      sessionId: session.id,
      harness: d.harness,
      workspaceId: workspace.id,
      prompt: d.prompt,
    });

    if (ack === null) {
      await runnerSessionRepository.finish(actor.orgId, session.id, { status: 'failed', error: 'device_offline' });
    } else if (!ack.accepted) {
      await runnerSessionRepository.finish(actor.orgId, session.id, {
        status: 'failed',
        error: ack.error ?? 'refused',
      });
    } else {
      await runnerSessionRepository.setStatus(actor.orgId, session.id, 'running');
    }

    const fresh = await this.reload(actor.orgId, session.id);
    logger.info('runner: session start', {
      orgId: actor.orgId,
      userId: actor.userId,
      deviceId: device.id,
      projectId: d.projectId,
      sessionId: session.id,
      status: fresh.status,
    });
    return fresh;
  }

  /**
   * A status line the SERVER produced, streamed on the same channel a runner's own updates use. `seq: 0`
   * because it can only ever be the first thing said about a session.
   */
  private emitStatus(userId: string, sessionId: string, text: string): void {
    const payload: RunnerSessionUpdatePayload = { sessionId, seq: 0, kind: 'status', text };
    emitToUser(userId, RUNNER_UI_EVENTS.SESSION_UPDATE, payload);
  }

  // ── Runner → member relays (called by the /runner socket handler; deviceId is the socket's identity) ──

  /**
   * Who a runner's report about `sessionId` goes to. Null — and a warning — when this device was never
   * dispatched that session: a stale or forged id, which must not move anyone's row or reach anyone's
   * screen.
   */
  private async route(deviceId: string, sessionId: string): Promise<{ orgId: string; userId: string } | null> {
    const routing = await runnerSessionRepository.findRouting(deviceId, sessionId);
    if (routing === null) {
      logger.warn('runner: report for a session not dispatched to this device', { deviceId, sessionId });
    }
    return routing;
  }

  /** A streamed increment from a runner: forward it to the member watching that session. */
  async handleUpdate(deviceId: string, payload: RunnerSessionUpdatePayload): Promise<void> {
    const routing = await this.route(deviceId, payload.sessionId);
    if (routing === null) return;
    emitToUser(routing.userId, RUNNER_UI_EVENTS.SESSION_UPDATE, payload);
  }

  /** A runner hit a permission gate: mark the session blocked and forward the prompt to the member. */
  async handlePermissionRequest(deviceId: string, payload: RunnerPermissionPromptPayload): Promise<void> {
    const routing = await this.route(deviceId, payload.sessionId);
    if (routing === null) return;
    await runnerSessionRepository.setStatusByDevice(deviceId, payload.sessionId, 'awaiting-permission');
    emitToUser(routing.userId, RUNNER_UI_EVENTS.PERMISSION_REQUEST, payload);
    // In addition to the Runners-screen socket stream, relay the gate to the chat the session was
    // started from (if any), so a WhatsApp/chat watcher can approve by simply replying "yes".
    await runnerChatRelayService.onPermission(routing.userId, payload);
  }

  /** A session reached a terminal state: record it (including the branch/tip it produced) and tell the member. */
  async handleDone(deviceId: string, payload: RunnerSessionDonePayload): Promise<void> {
    const routing = await this.route(deviceId, payload.sessionId);
    if (routing === null) return;
    await runnerSessionRepository.finishByDevice(deviceId, payload.sessionId, {
      status: payload.status,
      ...(payload.summary !== undefined ? { summary: payload.summary } : {}),
      ...(payload.error !== undefined ? { error: payload.error } : {}),
      ...(payload.branch !== undefined ? { branch: payload.branch } : {}),
      ...(payload.headSha !== undefined ? { headSha: payload.headSha } : {}),
    });
    emitToUser(routing.userId, RUNNER_UI_EVENTS.SESSION_DONE, payload);
    await runnerChatRelayService.onDone(payload);
  }

  // ── Member → runner relays (called by REST controllers) ─────────────────────────────────────────────

  /** Send a follow-up prompt to a running session. */
  async prompt(orgId: string, sessionId: string, text: string): Promise<RunnerSessionActionResponse> {
    this.assertEnabled();
    const session = await this.requireActive(orgId, sessionId);
    const delivered = await promptRunner(session.deviceId, { sessionId, text });
    if (delivered) await runnerSessionRepository.setStatus(orgId, sessionId, 'running');
    return { ok: delivered };
  }

  /** Relay the member's permission answer back to the runner. */
  async decidePermission(
    orgId: string,
    sessionId: string,
    promptId: string,
    optionId: string,
  ): Promise<RunnerSessionActionResponse> {
    this.assertEnabled();
    const session = await this.requireActive(orgId, sessionId);
    const delivered = await decidePermissionOnRunner(session.deviceId, { sessionId, promptId, optionId });
    if (delivered) await runnerSessionRepository.setStatus(orgId, sessionId, 'running');
    return { ok: delivered };
  }

  /** Ask the runner to stop a session. The runner's `session-done` (cancelled) finalises the row. */
  async cancel(orgId: string, sessionId: string): Promise<RunnerSessionActionResponse> {
    this.assertEnabled();
    const session = await this.requireActive(orgId, sessionId);
    const delivered = await cancelRunnerSession(session.deviceId, { sessionId });
    return { ok: delivered };
  }

  /** The org's sessions, newest first. */
  async listSessions(orgId: string): Promise<ListRunnerSessionsResponse> {
    this.assertEnabled();
    const sessions = await runnerSessionRepository.listByOrg(orgId);
    return { sessions };
  }

  /** One of the org's sessions, or 404. */
  async getSession(orgId: string, sessionId: string): Promise<RunnerSession> {
    this.assertEnabled();
    return this.reload(orgId, sessionId);
  }

  // ── Git follow-through (on a FINISHED session) ────────────────────────────────────────────────────────

  /**
   * Push a finished session's branch to its workspace remote. The runner does the git work with the
   * machine's own credentials; we relay the outcome and record that the branch is now pushed.
   */
  async pushSession(orgId: string, sessionId: string): Promise<PushRunnerSessionResponse> {
    this.assertEnabled();
    const session = await this.requireFinishedWithBranch(orgId, sessionId);

    const ack = await pushOnRunner(session.deviceId, { sessionId });
    if (ack === null) throw new ServiceUnavailableError('That machine is offline');
    if (!ack.ok) throw new ConflictError(this.gitFailure('Push failed', ack.error));

    await runnerSessionRepository.markPushed(orgId, sessionId);
    const fresh = await this.reload(orgId, sessionId);
    logger.info('runner: session pushed', { orgId, sessionId, deviceId: session.deviceId });
    return { session: fresh, remoteUrl: ack.remoteUrl ?? null };
  }

  /**
   * Open a pull request for a finished session's branch (the runner pushes it first if needed), via the
   * machine's `gh`. Records the PR URL against the session so the history links straight to it.
   */
  async openPr(orgId: string, sessionId: string, title: string, body: string): Promise<OpenRunnerPrResponse> {
    this.assertEnabled();
    const session = await this.requireFinishedWithBranch(orgId, sessionId);

    const ack = await openPrOnRunner(session.deviceId, { sessionId, title, body });
    if (ack === null) throw new ServiceUnavailableError('That machine is offline');
    if (!ack.ok) throw new ConflictError(this.gitFailure('Opening the pull request failed', ack.error));
    if (ack.prUrl === undefined) throw new ConflictError('The runner did not return a pull request URL');

    await runnerSessionRepository.recordPr(orgId, sessionId, ack.prUrl);
    const fresh = await this.reload(orgId, sessionId);
    logger.info('runner: session PR opened', { orgId, sessionId, deviceId: session.deviceId });
    return { session: fresh, prUrl: ack.prUrl };
  }

  /** Load a session that must exist in the org and not already be finished. */
  private async requireActive(orgId: string, sessionId: string): Promise<RunnerSession> {
    const session = await this.reload(orgId, sessionId);
    if (session.endedAt !== null) throw new ConflictError('That session has already ended');
    return session;
  }

  /** Load a FINISHED session that has an isolated branch — the precondition for any git follow-through. */
  private async requireFinishedWithBranch(orgId: string, sessionId: string): Promise<RunnerSession> {
    const session = await this.reload(orgId, sessionId);
    if (session.endedAt === null) throw new ConflictError('That session is still running');
    if (session.branch === null) throw new ConflictError('That session produced no branch to push');
    return session;
  }

  /** Read a session in its org, treating a missing row as the 404 it is. */
  private async reload(orgId: string, sessionId: string): Promise<RunnerSession> {
    const fresh = await runnerSessionRepository.get(orgId, sessionId);
    if (fresh === null) throw new NotFoundError('That session does not exist');
    return fresh;
  }

  /** A machine-readable runner error → an honest, specific user message (bounded so it can't be a payload). */
  private gitFailure(prefix: string, error: string | undefined): string {
    return error !== undefined && error.length > 0 ? `${prefix}: ${error.slice(0, 200)}` : prefix;
  }
}

export const runnerSessionService = new RunnerSessionService();
