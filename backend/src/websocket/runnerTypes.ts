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
 * listen to, put in a room, and hang up on, and nothing else. A real `Socket` satisfies this structurally.
 */
export interface RunnerSocketLike {
  readonly id: string;
  readonly data: SocketData;
  on(event: string, listener: (payload: unknown, ack?: (response: unknown) => void) => void): unknown;
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

/** The namespace, reduced to the questions we ask it: which of a user's runners are online, and reach them. */
export interface RunnerNamespaceLike {
  in(room: string): { fetchSockets(): Promise<RunnerRemoteSocketLike[]> };
}

/**
 * The room every one of a user's runners joins. Scoped by user, not device — but UNLIKE the bridge, work
 * is dispatched to a SPECIFIC device within this room (a runner's machines are not interchangeable: "run
 * this in my work laptop's repo" ≠ "my home desktop"). The room is how we enumerate a user's machines;
 * the `deviceId` is how we pick the one the user chose.
 */
export const runnerUserRoom = (userId: string): string => `runner_user_${userId}`;
