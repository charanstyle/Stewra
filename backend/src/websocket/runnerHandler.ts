import * as Sentry from '@sentry/node';
import { z } from 'zod';
import {
  HOST_ID_KINDS,
  RUNNER_CLIENT_EVENTS,
  RUNNER_HARNESS_IDS,
  RUNNER_PERMISSION_KINDS,
  RUNNER_SERVER_EVENTS,
  RUNNER_UPDATE_KINDS,
  meetsMinimumVersion,
} from '@stewra/shared-types';
import type {
  RunnerHarnessInfo,
  RunnerPermissionOption,
  RunnerPermissionPromptPayload,
  RunnerSessionDonePayload,
  RunnerSessionUpdatePayload,
  RunnerUpdateAvailablePayload,
  RunnerWorkspace,
} from '@stewra/shared-types';
import { config } from '../config/unifiedConfig.js';
import { hostedRunnerService } from '../services/hostedRunnerService.js';
import { machineAccessService } from '../services/machineAccessService.js';
import { runnerService } from '../services/runnerService.js';
import { runnerSessionService } from '../services/runnerSessionService.js';
import { logger } from '../utils/logger.js';
import { runnerDeviceRoom, runnerOrgRoom } from './runnerTypes.js';
import type { RunnerSocketLike } from './runnerTypes.js';

/**
 * Every payload below arrives from a process on someone else's machine. It is parsed, never trusted: a
 * runner could be old, buggy, or tampered with, and none of those may corrupt what we store.
 */
const harnessSchema = z.object({
  id: z.enum(RUNNER_HARNESS_IDS),
  available: z.boolean(),
  version: z.string().max(128).optional(),
});

const workspaceSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  path: z.string().min(1).max(1024),
  gitRemote: z.string().max(512).optional(),
  defaultBranch: z.string().max(256).optional(),
});

/**
 * Which computer the runner is on — the other half of the pair that lets the server recognise a Stewra
 * Bridge on the same box. Optional: runners older than `RUNNER_HOST_MIN_VERSION` do not send it, and a
 * hosted container has no desktop to be on.
 */
const hostSchema = z.object({
  kind: z.enum(HOST_ID_KINDS),
  value: z.string().min(1).max(128),
  hostname: z.string().min(1).max(255),
});

const helloSchema = z.object({
  appVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  os: z.string().max(32),
  harnesses: z.array(harnessSchema).max(16),
  workspaces: z.array(workspaceSchema).max(256),
  host: hostSchema.optional(),
});

const updateSchema = z.object({
  sessionId: z.string().min(1).max(128),
  seq: z.number().int().nonnegative(),
  kind: z.enum(RUNNER_UPDATE_KINDS),
  text: z.string().max(50_000).optional(),
  tool: z.string().max(256).optional(),
});

const doneSchema = z.object({
  sessionId: z.string().min(1).max(128),
  status: z.enum(['completed', 'failed', 'cancelled']),
  summary: z.string().max(10_000).optional(),
  error: z.string().max(2_000).optional(),
  branch: z.string().max(255).optional(),
  headSha: z.string().max(64).optional(),
  committed: z.boolean().optional(),
});

const permissionOptionSchema = z.object({
  id: z.string().min(1).max(256),
  label: z.string().min(1).max(256),
  kind: z.enum(RUNNER_PERMISSION_KINDS),
});

const permissionRequestSchema = z.object({
  sessionId: z.string().min(1).max(128),
  promptId: z.string().min(1).max(128),
  title: z.string().max(500),
  detail: z.string().max(2_000),
  options: z.array(permissionOptionSchema).min(1).max(16),
});

/** Rebuild optional-bearing payloads so an absent field stays absent under exactOptionalPropertyTypes. */
function toUpdatePayload(d: z.infer<typeof updateSchema>): RunnerSessionUpdatePayload {
  return {
    sessionId: d.sessionId,
    seq: d.seq,
    kind: d.kind,
    ...(d.text !== undefined ? { text: d.text } : {}),
    ...(d.tool !== undefined ? { tool: d.tool } : {}),
  };
}
function toDonePayload(d: z.infer<typeof doneSchema>): RunnerSessionDonePayload {
  return {
    sessionId: d.sessionId,
    status: d.status,
    ...(d.summary !== undefined ? { summary: d.summary } : {}),
    ...(d.error !== undefined ? { error: d.error } : {}),
    ...(d.branch !== undefined ? { branch: d.branch } : {}),
    ...(d.headSha !== undefined ? { headSha: d.headSha } : {}),
    ...(d.committed !== undefined ? { committed: d.committed } : {}),
  };
}
function toPermissionPayload(d: z.infer<typeof permissionRequestSchema>): RunnerPermissionPromptPayload {
  const options: RunnerPermissionOption[] = d.options.map((o) => ({ id: o.id, label: o.label, kind: o.kind }));
  return { sessionId: d.sessionId, promptId: d.promptId, title: d.title, detail: d.detail, options };
}

/** Rebuild optional-bearing objects so an absent field stays absent under exactOptionalPropertyTypes. */
function normalizeHarness(h: z.infer<typeof harnessSchema>): RunnerHarnessInfo {
  return { id: h.id, available: h.available, ...(h.version !== undefined ? { version: h.version } : {}) };
}
function normalizeWorkspace(w: z.infer<typeof workspaceSchema>): RunnerWorkspace {
  return {
    id: w.id,
    name: w.name,
    path: w.path,
    ...(w.gitRemote !== undefined ? { gitRemote: w.gitRemote } : {}),
    ...(w.defaultBranch !== undefined ? { defaultBranch: w.defaultBranch } : {}),
  };
}

/**
 * Wire up one connected Stewra Runner.
 *
 * Intentionally NOT a `BaseSocketHandler` (same reasoning as the bridge): that base class gives user
 * clients chat rooms, presence, and a per-socket event budget — none of which a runner may have. Keeping
 * the machinery unreachable is surer than a rule someone must remember not to break.
 *
 * Handles `runner:hello` (announce + persist capabilities so the "Runners" panel can render what each
 * machine can do) and the session lifecycle events a hosting runner emits: session-update,
 * session-done, and permission-request.
 */
export function registerRunnerHandler(socket: RunnerSocketLike): void {
  const { userId, deviceId, deviceKind, orgId } = socket.data;

  // The door check. `runnerAuthMiddleware` sets `deviceId` and `orgId` on every socket that gets this
  // far, so this can only fire if something is wired wrong — and a runner whose device or tenant we
  // cannot name is one we cannot revoke, address, or list. It gets no events.
  if (deviceId === undefined || orgId === undefined) {
    // Same wiring fault as bridgeHandler's door check, and the same reason it must page rather than log.
    Sentry.captureMessage('runner: connection without a device or org id; refusing', {
      level: 'error',
      tags: { surface: 'runner_handler' },
      extra: { userId, socketId: socket.id },
    });
    logger.error('runner: connection without a device or org id; refusing', { userId, socketId: socket.id });
    socket.disconnect();
    return;
  }

  // The device room is how a session is addressed to THIS machine; the org room is how the org's
  // machines are enumerated for the online dots.
  void socket.join(runnerDeviceRoom(deviceId));
  void socket.join(runnerOrgRoom(orgId));

  /** Run a handler, capturing anything it throws — a bad frame must never take the connection down. */
  const guard = (event: string, fn: () => Promise<void>): void => {
    void fn().catch((error: unknown) => {
      Sentry.captureException(error);
      logger.error('runner handler error', {
        event,
        userId,
        deviceId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  socket.on(RUNNER_CLIENT_EVENTS.HELLO, (raw: unknown) => {
    const parsed = helloSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn('runner: rejected a malformed hello', { userId, deviceId });
      return;
    }
    logger.info('runner: hello', {
      userId,
      deviceId,
      os: parsed.data.os,
      appVersion: parsed.data.appVersion,
      harnesses: parsed.data.harnesses.filter((h) => h.available).map((h) => h.id),
      workspaces: parsed.data.workspaces.length,
    });
    guard(RUNNER_CLIENT_EVENTS.HELLO, () =>
      runnerService.recordCapabilities(deviceId, {
        os: parsed.data.os,
        appVersion: parsed.data.appVersion,
        harnesses: parsed.data.harnesses.map(normalizeHarness),
        workspaces: parsed.data.workspaces.map(normalizeWorkspace),
      }),
    );

    // Which computer this is. Every hello, not just the first: a machine can be re-imaged, and a stale
    // host id would let Stewra place a bridge on the wrong box with total confidence.
    const { host } = parsed.data;
    if (host !== undefined) {
      guard(RUNNER_CLIENT_EVENTS.HELLO, () => machineAccessService.noteRunnerHost(deviceId, host));
    }

    // A hosted runner that says hello has proved its container is up, which is stronger evidence than
    // anything the provisioner can report — Docker's "running" only means the process started. This is
    // also what closes the gap after a wake: the row says 'starting' until the runner itself lands here.
    if (deviceKind === 'hosted') {
      guard(RUNNER_CLIENT_EVENTS.HELLO, () => hostedRunnerService.noteConnected(deviceId));
    }

    // Notify-only upgrade nudge: a runner behind the latest published build gets told, once per hello,
    // where to get the new one. Nothing more — the runner never self-replaces its binary. Runners older
    // than this event simply ignore it (unknown Socket.IO events are dropped client-side).
    if (!meetsMinimumVersion(parsed.data.appVersion, config.runner.latestVersion)) {
      const payload: RunnerUpdateAvailablePayload = {
        latestVersion: config.runner.latestVersion,
        downloadUrl: config.runner.downloadUrl,
      };
      socket.emit(RUNNER_SERVER_EVENTS.UPDATE_AVAILABLE, payload);
      logger.info('runner: told device an update is available', {
        userId,
        deviceId,
        appVersion: parsed.data.appVersion,
        latestVersion: config.runner.latestVersion,
      });
    }
  });

  // ── Session lifecycle: a runner's reports about the agent runs it is hosting ─────────────────────────
  // Each is validated (a bad frame is dropped, never allowed to move a session), then handed to the
  // session service, which persists the transition and relays it to the member who started the session.
  // The service is given the DEVICE id, never the pairer's user id: a runner's authority is "this
  // machine", and the session row — not the socket — says which person is watching.

  socket.on(RUNNER_CLIENT_EVENTS.SESSION_UPDATE, (raw: unknown) => {
    const parsed = updateSchema.safeParse(raw);
    if (!parsed.success) return;
    guard(RUNNER_CLIENT_EVENTS.SESSION_UPDATE, () =>
      runnerSessionService.handleUpdate(deviceId, toUpdatePayload(parsed.data)),
    );
  });

  socket.on(RUNNER_CLIENT_EVENTS.PERMISSION_REQUEST, (raw: unknown) => {
    const parsed = permissionRequestSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn('runner: rejected a malformed permission-request', { userId, deviceId });
      return;
    }
    guard(RUNNER_CLIENT_EVENTS.PERMISSION_REQUEST, () =>
      runnerSessionService.handlePermissionRequest(deviceId, toPermissionPayload(parsed.data)),
    );
  });

  socket.on(RUNNER_CLIENT_EVENTS.SESSION_DONE, (raw: unknown) => {
    const parsed = doneSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn('runner: rejected a malformed session-done', { userId, deviceId });
      return;
    }
    guard(RUNNER_CLIENT_EVENTS.SESSION_DONE, () =>
      runnerSessionService.handleDone(deviceId, toDonePayload(parsed.data)),
    );
  });

  socket.on('disconnect', () => {
    // Nothing to persist: `online` is composed live from who is connected, so a disconnect needs no state
    // flip. Logged so the runner's lifecycle is visible.
    logger.debug('runner: disconnected', { userId, deviceId });
  });
}
