import type { AppServer } from './types';
import { conversationRoom, userRoom } from './types';

/**
 * The bridge that lets the REST layer (controllers) notify sockets after a write commits, WITHOUT
 * depending on the server lifecycle in `index.ts`. `initSockets` calls `setIo` once; controllers call
 * the `emitTo*` helpers. Before the socket server exists (e.g. in a pure-REST supertest run) the
 * reference is null and emits are silently skipped — persistence is the source of truth, the socket is
 * only the notify bus, so a missing bus never fails a request.
 */
let ioRef: AppServer | null = null;

export function setIo(io: AppServer): void {
  ioRef = io;
}

/** Emit to everyone currently in a conversation room (live message/typing/receipt/reaction fan-out). */
export function emitToConversation(conversationId: string, event: string, payload: unknown): void {
  ioRef?.to(conversationRoom(conversationId)).emit(event, payload);
}

/** Emit to a user's personal room across all their devices (incoming call, unread bump, Stewra reply). */
export function emitToUser(userId: string, event: string, payload: unknown): void {
  ioRef?.to(userRoom(userId)).emit(event, payload);
}
