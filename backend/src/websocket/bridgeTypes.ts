import type { DefaultEventsMap, Namespace, Socket } from 'socket.io';
import type { SocketData } from './types.js';

/**
 * A connected Stewra Bridge, and the namespace they live in.
 *
 * The generics match the main namespace's because Socket.IO gives a server ONE `SocketData` type for all
 * of its namespaces. What actually separates a bridge from a user client is therefore not the type — it
 * is `bridgeAuthMiddleware` (a device token, not a JWT) and `registerBridgeHandler` (no chat rooms, no
 * presence, no conversation events). A bridge's `socket.data.deviceId` is set there and nowhere else.
 */
export type BridgeNamespace = Namespace<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  SocketData
>;
export type BridgeSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  SocketData
>;

/**
 * The slices of Socket.IO that the bridge code actually touches.
 *
 * The handler and the emitter are typed against THESE, not against `Socket`/`Namespace`, for two reasons.
 * It states the surface honestly — a bridge socket is something we listen to, put in a room, and hang up
 * on, and nothing else. And it means the tests can drive the whole namespace with a fake bridge client and
 * no transport at all, which is the point of Phase 2: every rule that protects a user's WhatsApp account
 * (the allowlist gate, the dedupe, the echo-loop break, the send budget) is provable with no Electron, no
 * Baileys, and no real socket in sight. A real `Socket`/`Namespace` satisfies these structurally.
 */
export interface BridgeSocketLike {
  readonly id: string;
  readonly data: SocketData;
  on(event: string, listener: (payload: unknown) => void): unknown;
  join(room: string): unknown;
  disconnect(close?: boolean): unknown;
}

/**
 * A socket still in the handshake, before it is trusted — everything the auth middleware may look at.
 *
 * The two places a bridge may present its token, and nothing else. `token` and `authorization` are typed
 * `unknown` rather than `string` because they arrive off the wire: a client can put a number, an object,
 * or nothing at all there, and the middleware has to survive all three.
 */
export interface BridgeHandshakeSocketLike {
  readonly id: string;
  data: SocketData;
  readonly handshake: {
    readonly auth: { token?: unknown };
    readonly headers: { authorization?: unknown };
  };
}

/** One connected bridge as seen from another process (via the Redis adapter), i.e. how we send to it. */
export interface BridgeRemoteSocketLike {
  readonly data: SocketData;
  emit(event: string, payload: unknown): unknown;
  disconnect(close?: boolean): unknown;
  timeout(ms: number): { emitWithAck(event: string, payload: unknown): Promise<unknown> };
}

/** The namespace, reduced to the one question we ask it: which of this user's bridges are online? */
export interface BridgeNamespaceLike {
  in(room: string): { fetchSockets(): Promise<BridgeRemoteSocketLike[]> };
}

/**
 * The room every one of a user's bridges joins. Scoped by user, not device, so a queued send can find
 * whichever machine happens to be awake — the outbox is drained by whoever shows up, not by the one
 * particular laptop that was online when the user hit Send.
 */
export const bridgeUserRoom = (userId: string): string => `bridge_user_${userId}`;
