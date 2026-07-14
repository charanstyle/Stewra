import type { DefaultEventsMap, Server, Socket } from 'socket.io';

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
