import type { DefaultEventsMap, Namespace, Socket } from 'socket.io';
import type { SocketData } from './types.js';

/**
 * A connected Stewra Runner, and the namespace they live in.
 *
 * Like the bridge, the generics match the main namespace's because Socket.IO gives a server ONE
 * `SocketData` type across all namespaces. What separates a runner from a user client is not the type — it
 * is `runnerAuthMiddleware` (a device token, not a JWT) and `registerRunnerHandler` (no chat rooms, no
 * presence, no conversation events). A runner's `socket.data.deviceId` is set in that middleware.
 */
export type RunnerNamespace = Namespace<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;
export type RunnerSocket = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;

/**
 * The slices of Socket.IO the runner code actually touches — the handler is typed against THIS, not
 * `Socket`, so the rules are provable with a fake client and no transport: a runner socket is something we
 * listen to, put in a room, answer directly (the update-available nudge), and hang up on, and nothing
 * else. A real `Socket` satisfies this structurally.
 */
export interface RunnerSocketLike {
  readonly id: string;
  readonly data: SocketData;
  on(event: string, listener: (payload: unknown, ack?: (response: unknown) => void) => void): unknown;
  emit(event: string, payload: unknown): unknown;
  join(room: string): unknown;
  disconnect(close?: boolean): unknown;
}

/** A socket still in the handshake, before it is trusted — everything the auth middleware may look at. */
export interface RunnerHandshakeSocketLike {
  readonly id: string;
  data: SocketData;
  readonly handshake: {
    readonly auth: { token?: unknown };
    readonly headers: { authorization?: unknown };
  };
}

/** One connected runner as seen from another process (via the Redis adapter), i.e. how we send to it. */
export interface RunnerRemoteSocketLike {
  readonly data: SocketData;
  emit(event: string, payload: unknown): unknown;
  disconnect(close?: boolean): unknown;
  timeout(ms: number): { emitWithAck(event: string, payload: unknown): Promise<unknown> };
}

/** The namespace, reduced to the questions we ask it: which of an org's runners are online, and reach one. */
export interface RunnerNamespaceLike {
  in(room: string): { fetchSockets(): Promise<RunnerRemoteSocketLike[]> };
}

/**
 * Every runner socket joins two rooms.
 *
 * The DEVICE room is how work is addressed: a runner's machines are not interchangeable ("run this in my
 * work laptop's repo" ≠ "my home desktop"), so dispatch names one device and nothing else. Authorization
 * happened before this point — the repository lookup that produced the device id was scoped by org — so
 * the room itself carries no tenant and needs none.
 *
 * The ORG room is how a tenant's machines are enumerated for the online dots on the fleet page. It is
 * keyed by org, not by the user who paired the machine, because the machine is the organization's.
 */
export const runnerDeviceRoom = (deviceId: string): string => `runner_device_${deviceId}`;
export const runnerOrgRoom = (orgId: string): string => `runner_org_${orgId}`;
