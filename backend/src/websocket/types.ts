import type { DefaultEventsMap, Server, Socket } from 'socket.io';
import type { RunnerDeviceKind } from '@stewra/shared-types';

/** Per-connection state set by the auth middleware. `userId` is the authenticated subject. */
export interface SocketData {
  userId: string;
  /**
   * The Stewra Bridge device this socket speaks for. Present ONLY on `/bridge` sockets — never on a user
   * client, which has no device.
   *
   * It lives here, optional, rather than in a `BridgeSocketData` of its own because Socket.IO pins a
   * single `SocketData` type across every namespace of a server: `io.of('/bridge')` cannot hand back a
   * differently-typed namespace. `registerBridgeHandler` therefore checks for it at the door and refuses
   * the connection if it is missing, so every line of bridge code below that check has a real device id —
   * a runtime guarantee, not a type assertion papering over the library's shape.
   */
  deviceId?: string;
  /**
   * The Stewra Bridge build on the other end, as it announced itself in `bridge:hello`. Present only on
   * `/bridge` sockets, and only after hello. It decides what the server may ask of this bridge: a build
   * older than `BRIDGE_VOICE_MIN_VERSION` strips `audio` from a send and would deliver a voice note as a
   * second copy of the text, so such a send is refused rather than handed over.
   */
  bridgeAppVersion?: string;
  /**
   * Whether the `/runner` socket on the other end is a machine the user owns or a container Stewra
   * hosts. Present only on runner sockets, for the same Socket.IO reason `deviceId` is.
   *
   * Carried on the socket rather than looked up per event so that "is this one of ours?" — the question
   * that decides whether Stewra will start, stop, or hand credentials to it — is answered once, at the
   * door, from the same row that authenticated the token.
   */
  deviceKind?: RunnerDeviceKind;
  /**
   * The organization the `/runner` device belongs to, from the same row that authenticated its token.
   * Present only on runner sockets. It is what puts the socket in its org's room, which is how the
   * fleet page's online dots are composed per tenant.
   */
  orgId?: string;
}

/**
 * Typed Socket.IO aliases. Event payloads are validated explicitly against the shared-types
 * `realtime/payloads` contract at each handler (via `BaseSocketHandler.on`), so we keep the emit/listen
 * maps as the default (loose) maps rather than threading a full typed event map through every generic —
 * the strong typing lives at the call sites where payloads are parsed.
 */
export type AppServer = Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;
export type AppSocket = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;

/** The room a user's personal fan-out (presence, incoming messages/calls, Stewra replies) targets. */
export const userRoom = (userId: string): string => `user_${userId}`;
/** The room a conversation's live traffic (messages, typing, receipts) is emitted to. */
export const conversationRoom = (conversationId: string): string => `conversation_${conversationId}`;
/** The room a single call's signaling (offer/answer/ICE) flows through. */
export const callRoom = (callId: string): string => `call_${callId}`;
/** The room that carries presence updates for a watched user (subscribers join it). */
export const presenceRoom = (userId: string): string => `presence_${userId}`;
