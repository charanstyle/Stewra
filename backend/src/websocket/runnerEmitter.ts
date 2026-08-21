import { z } from 'zod';
import { RUNNER_SERVER_EVENTS } from '@stewra/shared-types';
import type {
  RunnerCancelPayload,
  RunnerGitActionAck,
  RunnerOpenPrPayload,
  RunnerPermissionDecisionPayload,
  RunnerPromptPayload,
  RunnerPushPayload,
  RunnerStartSessionAck,
  RunnerStartSessionPayload,
} from '@stewra/shared-types';
import * as Sentry from '@sentry/node';
import type { RunnerNamespaceLike, RunnerRemoteSocketLike } from './runnerTypes.js';
import { runnerDeviceRoom, runnerOrgRoom } from './runnerTypes.js';
import { logger } from '../utils/logger.js';

/** How long we wait for a runner to accept (or refuse) a new session before treating it as unreachable. */
const START_SESSION_ACK_TIMEOUT_MS = 15_000;

let namespace: RunnerNamespaceLike | null = null;

/** Wired once at boot by `initSockets`, so services can reach runners without importing the server. */
export function setRunnerNamespace(ns: RunnerNamespaceLike): void {
  namespace = ns;
}

/**
 * Find the ONE online socket for a specific device. Unlike the bridge (which picks any online machine
 * because they're interchangeable relays), a runner's machines are not: work is addressed to the exact
 * device the user chose. Returns null when that device isn't currently connected.
 *
 * There is no tenant parameter here on purpose. Authorization is the org-scoped repository lookup that
 * produced `deviceId` in the first place; by the time a caller has a device id to address, it has already
 * proved it may. Re-scoping the room by user was the latent bug: it enumerated the PAIRER's machines, so
 * a teammate's session could never find the device.
 */
async function findDevice(deviceId: string): Promise<RunnerRemoteSocketLike | null> {
  if (namespace === null) return null;
  const sockets = await namespace.in(runnerDeviceRoom(deviceId)).fetchSockets();
  return sockets.find((s) => s.data.deviceId === deviceId) ?? null;
}

/** The runner's start ack is a payload from someone else's machine — parsed, never trusted. */
const startSessionAckSchema = z.object({
  accepted: z.boolean(),
  error: z.string().max(500).optional(),
});

/**
 * Ask ONE chosen runner to begin a session, and wait for it to accept or refuse.
 *
 * Returns null when the device is offline — a normal state (the laptop is shut), distinct from a device
 * that answered `{ accepted: false }` because it doesn't have the harness/workspace or is at capacity. The
 * caller turns each into a different, honest UI message rather than a generic failure.
 */
export async function startSessionOnRunner(
  deviceId: string,
  payload: RunnerStartSessionPayload,
): Promise<RunnerStartSessionAck | null> {
  const target = await findDevice(deviceId);
  if (target === null) return null;

  let raw: unknown;
  try {
    raw = await target.timeout(START_SESSION_ACK_TIMEOUT_MS).emitWithAck(RUNNER_SERVER_EVENTS.START_SESSION, payload);
  } catch {
    // A connected runner that will not acknowledge a start. See bridgeEmitter for the same reasoning.
    Sentry.captureMessage('runner: start-session ack timed out', {
      level: 'warning',
      tags: { surface: 'runner_emit', op: 'start_session' },
      extra: { deviceId, sessionId: payload.sessionId },
    });
    logger.warn('runner: start-session ack timed out', { deviceId, sessionId: payload.sessionId });
    return { accepted: false, error: 'ack_timeout' };
  }

  const parsed = startSessionAckSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn('runner: malformed start-session ack', { deviceId, sessionId: payload.sessionId });
    return { accepted: false, error: 'malformed_ack' };
  }
  // Rebuilt so an absent `error` stays absent under exactOptionalPropertyTypes.
  return {
    accepted: parsed.data.accepted,
    ...(parsed.data.error !== undefined ? { error: parsed.data.error } : {}),
  };
}

/**
 * Fire an instruction at a chosen runner that needs no ack: a follow-up prompt, a permission answer, or a
 * cancel. Returns false when the device is offline so the caller can surface "this machine went away"
 * rather than pretend the instruction landed.
 */
async function sendToDevice(deviceId: string, event: string, payload: unknown): Promise<boolean> {
  const target = await findDevice(deviceId);
  if (target === null) return false;
  target.emit(event, payload);
  return true;
}

export function promptRunner(deviceId: string, payload: RunnerPromptPayload): Promise<boolean> {
  return sendToDevice(deviceId, RUNNER_SERVER_EVENTS.PROMPT, payload);
}

export function decidePermissionOnRunner(
  deviceId: string,
  payload: RunnerPermissionDecisionPayload,
): Promise<boolean> {
  return sendToDevice(deviceId, RUNNER_SERVER_EVENTS.PERMISSION_DECISION, payload);
}

export function cancelRunnerSession(deviceId: string, payload: RunnerCancelPayload): Promise<boolean> {
  return sendToDevice(deviceId, RUNNER_SERVER_EVENTS.CANCEL, payload);
}

/** Ask a runner to re-scan its workspace roots and say hello again (the volume was remounted, say). */
export function rescanRunner(deviceId: string): Promise<boolean> {
  return sendToDevice(deviceId, RUNNER_SERVER_EVENTS.RESCAN, {});
}

/** How long we wait for a runner to do the git work (push/PR reach the network) before giving up. */
const GIT_ACTION_ACK_TIMEOUT_MS = 130_000;

/** The runner's git-action ack is a payload from someone else's machine — parsed, never trusted. */
const gitActionAckSchema = z.object({
  ok: z.boolean(),
  branch: z.string().max(255).optional(),
  remoteUrl: z.string().max(1024).optional(),
  prUrl: z.string().max(1024).optional(),
  error: z.string().max(500).optional(),
});

/**
 * Ask ONE chosen runner to run a git follow-through action (push / open-PR) on a finished session, and wait
 * for its result. Returns null when the device is offline (a normal state — the laptop is shut), distinct
 * from a device that answered `{ ok: false, error }` because the push/PR itself failed. The runner does the
 * git work with the machine's own credentials; the server only relays the outcome.
 */
async function gitActionOnRunner(
  deviceId: string,
  event: string,
  payload: unknown,
): Promise<RunnerGitActionAck | null> {
  const target = await findDevice(deviceId);
  if (target === null) return null;

  let raw: unknown;
  try {
    raw = await target.timeout(GIT_ACTION_ACK_TIMEOUT_MS).emitWithAck(event, payload);
  } catch {
    // As above: connected, addressed, and silent.
    Sentry.captureMessage('runner: git-action ack timed out', {
      level: 'warning',
      tags: { surface: 'runner_emit', op: 'git_action' },
      extra: { deviceId, event },
    });
    logger.warn('runner: git-action ack timed out', { deviceId, event });
    return { ok: false, error: 'ack_timeout' };
  }

  const parsed = gitActionAckSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn('runner: malformed git-action ack', { deviceId, event });
    return { ok: false, error: 'malformed_ack' };
  }
  // Rebuilt so absent optionals stay absent under exactOptionalPropertyTypes.
  return {
    ok: parsed.data.ok,
    ...(parsed.data.branch !== undefined ? { branch: parsed.data.branch } : {}),
    ...(parsed.data.remoteUrl !== undefined ? { remoteUrl: parsed.data.remoteUrl } : {}),
    ...(parsed.data.prUrl !== undefined ? { prUrl: parsed.data.prUrl } : {}),
    ...(parsed.data.error !== undefined ? { error: parsed.data.error } : {}),
  };
}

export function pushOnRunner(deviceId: string, payload: RunnerPushPayload): Promise<RunnerGitActionAck | null> {
  return gitActionOnRunner(deviceId, RUNNER_SERVER_EVENTS.PUSH, payload);
}

export function openPrOnRunner(deviceId: string, payload: RunnerOpenPrPayload): Promise<RunnerGitActionAck | null> {
  return gitActionOnRunner(deviceId, RUNNER_SERVER_EVENTS.OPEN_PR, payload);
}

/**
 * The set of the org's runner device ids that have a socket connected RIGHT NOW.
 *
 * This is how the fleet page shows a truthful online dot: composed from who is actually connected,
 * across every backend instance (the Redis adapter makes `fetchSockets` cluster-wide), rather than from a
 * stored flag that an unclean disconnect would leave lying. Returns an empty set when nothing is mounted.
 */
export async function listOnlineDeviceIds(orgId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  if (namespace === null) return ids;
  const sockets = await namespace.in(runnerOrgRoom(orgId)).fetchSockets();
  for (const socket of sockets) {
    if (socket.data.deviceId !== undefined) ids.add(socket.data.deviceId);
  }
  return ids;
}

/** Whether ONE device has a socket connected right now — for the paths that hold a device id and no org. */
export async function isDeviceOnline(deviceId: string): Promise<boolean> {
  return (await findDevice(deviceId)) !== null;
}

/**
 * Tell ONE revoked runner to stop everything and shut down, then cut it off.
 *
 * Targeted at the single revoked device's room, never an org's: an org may run several machines, and
 * revoking the laptop must not tear down the desktop. The disconnect is what actually enforces anything
 * — the REVOKED event is a courtesy so the runner can wipe its token and stop its sessions cleanly; a
 * runner that ignores it still dies here, and its token row is already gone.
 */
export async function notifyRunnerRevoked(deviceId: string): Promise<void> {
  if (namespace === null) return;
  const sockets = await namespace.in(runnerDeviceRoom(deviceId)).fetchSockets();
  for (const socket of sockets) {
    if (socket.data.deviceId !== deviceId) continue;
    socket.emit(RUNNER_SERVER_EVENTS.REVOKED, {});
    socket.disconnect();
  }
}
