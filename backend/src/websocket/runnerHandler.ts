import * as Sentry from '@sentry/node';
import { z } from 'zod';
import { RUNNER_CLIENT_EVENTS, RUNNER_HARNESS_IDS } from '@stewra/shared-types';
import type { RunnerHarnessInfo, RunnerWorkspace } from '@stewra/shared-types';
import { runnerService } from '../services/runnerService.js';
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

  socket.on('disconnect', () => {
    // Nothing to persist: `online` is composed live from who is connected, so a disconnect needs no state
    // flip. Logged so the runner's lifecycle is visible.
    logger.debug('runner: disconnected', { userId, deviceId });
  });
}
