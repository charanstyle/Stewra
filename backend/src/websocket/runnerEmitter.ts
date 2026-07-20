import { RUNNER_SERVER_EVENTS } from '@stewra/shared-types';
import type { RunnerNamespaceLike } from './runnerTypes.js';
import { runnerUserRoom } from './runnerTypes.js';

let namespace: RunnerNamespaceLike | null = null;

/** Wired once at boot by `initSockets`, so services can reach runners without importing the server. */
export function setRunnerNamespace(ns: RunnerNamespaceLike): void {
  namespace = ns;
}

/**
 * The set of the user's runner device ids that have a socket connected RIGHT NOW.
 *
 * This is how the "Runners" panel shows a truthful online dot: composed from who is actually connected,
 * across every backend instance (the Redis adapter makes `fetchSockets` cluster-wide), rather than from a
 * stored flag that an unclean disconnect would leave lying. Returns an empty set when nothing is mounted.
 */
export async function listOnlineDeviceIds(userId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  if (namespace === null) return ids;
  const sockets = await namespace.in(runnerUserRoom(userId)).fetchSockets();
  for (const socket of sockets) {
    if (socket.data.deviceId !== undefined) ids.add(socket.data.deviceId);
  }
  return ids;
}

/**
 * Tell ONE revoked runner to stop everything and shut down, then cut it off.
 *
 * Targeted at the single revoked `deviceId`, never broadcast to the user's room: a user may run several
 * machines, and revoking the laptop must not tear down the desktop. The disconnect is what actually
 * enforces anything — the REVOKED event is a courtesy so the runner can wipe its token and stop its
 * sessions cleanly; a runner that ignores it still dies here, and its token row is already gone.
 */
export async function notifyRunnerRevoked(userId: string, deviceId: string): Promise<void> {
  if (namespace === null) return;
  const sockets = await namespace.in(runnerUserRoom(userId)).fetchSockets();
  for (const socket of sockets) {
    if (socket.data.deviceId !== deviceId) continue;
    socket.emit(RUNNER_SERVER_EVENTS.REVOKED, {});
    socket.disconnect();
  }
}
