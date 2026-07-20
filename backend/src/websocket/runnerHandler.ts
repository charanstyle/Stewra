import * as Sentry from '@sentry/node';
import { z } from 'zod';
import {
  RUNNER_CLIENT_EVENTS,
  RUNNER_HARNESS_IDS,
  RUNNER_PERMISSION_KINDS,
  RUNNER_UPDATE_KINDS,
} from '@stewra/shared-types';
import type {
  RunnerHarnessInfo,
  RunnerPermissionOption,
  RunnerPermissionPromptPayload,
  RunnerSessionDonePayload,
  RunnerSessionUpdatePayload,
  RunnerWorkspace,
} from '@stewra/shared-types';
import { runnerService } from '../services/runnerService.js';
import { runnerSessionService } from '../services/runnerSessionService.js';
import { logger } from '../utils/logger.js';
import { runnerUserRoom } from './runnerTypes.js';
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

const helloSchema = z.object({
  appVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  os: z.string().max(32),
  harnesses: z.array(harnessSchema).max(16),
  workspaces: z.array(workspaceSchema).max(256),
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
 * Phase 1 handles only `runner:hello` — announce + persist capabilities so the "Runners" panel can render
 * what each machine can do. The session lifecycle handlers (session-update, session-done,
 * permission-request) land in Phase 2, when the runner actually hosts an ACP session.
 */
export function registerRunnerHandler(socket: RunnerSocketLike): void {
  const { userId, deviceId } = socket.data;

  // The door check. `runnerAuthMiddleware` sets `deviceId` on every socket that gets this far, so this can
  // only fire if something is wired wrong — and a runner whose device we cannot name is one we cannot
  // revoke or address. It gets no events.
  if (deviceId === undefined) {
    logger.error('runner: connection without a device id; refusing', { userId, socketId: socket.id });
    socket.disconnect();
    return;
  }

  // Joined so the user's machines can be enumerated (online dots) and a session can be addressed to one.
  void socket.join(runnerUserRoom(userId));

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
        harnesses: parsed.data.harnesses.map(normalizeHarness),
        workspaces: parsed.data.workspaces.map(normalizeWorkspace),
      }),
    );
  });

  // ── Session lifecycle: a runner's reports about the agent runs it is hosting ─────────────────────────
  // Each is validated (a bad frame is dropped, never allowed to move a session), then handed to the
  // session service, which persists the transition and relays it to the user watching on the main socket.

  socket.on(RUNNER_CLIENT_EVENTS.SESSION_UPDATE, (raw: unknown) => {
    const parsed = updateSchema.safeParse(raw);
    if (!parsed.success) return;
    runnerSessionService.handleUpdate(userId, toUpdatePayload(parsed.data));
  });

  socket.on(RUNNER_CLIENT_EVENTS.PERMISSION_REQUEST, (raw: unknown) => {
    const parsed = permissionRequestSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn('runner: rejected a malformed permission-request', { userId, deviceId });
      return;
    }
    guard(RUNNER_CLIENT_EVENTS.PERMISSION_REQUEST, () =>
      runnerSessionService.handlePermissionRequest(userId, toPermissionPayload(parsed.data)),
    );
  });

  socket.on(RUNNER_CLIENT_EVENTS.SESSION_DONE, (raw: unknown) => {
    const parsed = doneSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn('runner: rejected a malformed session-done', { userId, deviceId });
      return;
    }
    guard(RUNNER_CLIENT_EVENTS.SESSION_DONE, () =>
      runnerSessionService.handleDone(userId, toDonePayload(parsed.data)),
    );
  });

  socket.on('disconnect', () => {
    // Nothing to persist: `online` is composed live from who is connected, so a disconnect needs no state
    // flip. Logged so the runner's lifecycle is visible.
    logger.debug('runner: disconnected', { userId, deviceId });
  });
}
