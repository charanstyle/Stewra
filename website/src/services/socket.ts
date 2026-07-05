import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import {
  CLIENT_EVENTS,
  SERVER_EVENTS,
} from '@stewra/shared-types';
import type {
  PresenceSubscribePayload,
  PresenceUpdateEvent,
  ContactInviteReceivedEvent,
  ContactInviteAcceptedEvent,
  ChatJoinPayload,
  ChatTypingPayload,
  ChatMarkReadPayload,
  ChatMessageEvent,
  ChatDeliveredEvent,
  ChatReadEvent,
  ChatTypingEvent,
  ChatReactionEvent,
  CallInitiatePayload,
  CallLifecyclePayload,
  CallSignalPayload,
  CallIcePayload,
  CallIncomingEvent,
  CallAnsweredEvent,
  CallDeclinedEvent,
  CallEndedEvent,
  CallRemoteOfferEvent,
  CallRemoteAnswerEvent,
  CallRemoteIceEvent,
  CallErrorEvent,
  StewraThinkingEvent,
  StewraReplyEvent,
  StewraErrorEvent,
  ISODateString,
  CallSession,
} from '@stewra/shared-types';
import { readTokens, BASE_URL } from './api';

/**
 * A Socket.IO ack response. Handlers reply `{ ok: true, ... }` on success or `{ ok: false, error }` on
 * failure (see `baseSocketHandler` / `callSignalingHandler`). The extra success fields vary per event.
 */
export type Ack<T extends object = Record<string, never>> =
  | ({ readonly ok: true } & T)
  | { readonly ok: false; readonly error: string };

/** Events the client can emit, each with its payload and (optional) typed ack — mirrors the server. */
interface ClientToServerEvents {
  [CLIENT_EVENTS.PRESENCE_SUBSCRIBE]: (
    payload: PresenceSubscribePayload,
    ack: (res: Ack<{ statuses: ReadonlyArray<PresenceUpdateEvent> }>) => void,
  ) => void;
  [CLIENT_EVENTS.CHAT_JOIN]: (payload: ChatJoinPayload, ack: (res: Ack) => void) => void;
  [CLIENT_EVENTS.CHAT_LEAVE]: (payload: ChatJoinPayload, ack: (res: Ack) => void) => void;
  [CLIENT_EVENTS.CHAT_TYPING]: (payload: ChatTypingPayload, ack: (res: Ack) => void) => void;
  [CLIENT_EVENTS.CHAT_MARK_READ]: (
    payload: ChatMarkReadPayload,
    ack: (res: Ack<{ lastReadAt: ISODateString }>) => void,
  ) => void;
  [CLIENT_EVENTS.CALL_INITIATE]: (
    payload: CallInitiatePayload,
    ack: (res: Ack<{ call: CallSession }>) => void,
  ) => void;
  [CLIENT_EVENTS.CALL_ANSWER]: (payload: CallLifecyclePayload, ack: (res: Ack) => void) => void;
  [CLIENT_EVENTS.CALL_DECLINE]: (payload: CallLifecyclePayload, ack: (res: Ack) => void) => void;
  [CLIENT_EVENTS.CALL_END]: (payload: CallLifecyclePayload, ack: (res: Ack) => void) => void;
  [CLIENT_EVENTS.CALL_OFFER]: (payload: CallSignalPayload, ack: (res: Ack) => void) => void;
  [CLIENT_EVENTS.CALL_ANSWER_SDP]: (payload: CallSignalPayload, ack: (res: Ack) => void) => void;
  [CLIENT_EVENTS.CALL_ICE_CANDIDATE]: (payload: CallIcePayload, ack: (res: Ack) => void) => void;
}

/** Events the server emits to this client. */
interface ServerToClientEvents {
  [SERVER_EVENTS.PRESENCE_UPDATE]: (event: PresenceUpdateEvent) => void;
  [SERVER_EVENTS.CONTACT_INVITE_RECEIVED]: (event: ContactInviteReceivedEvent) => void;
  [SERVER_EVENTS.CONTACT_INVITE_ACCEPTED]: (event: ContactInviteAcceptedEvent) => void;
  [SERVER_EVENTS.CHAT_MESSAGE]: (event: ChatMessageEvent) => void;
  [SERVER_EVENTS.CHAT_MESSAGE_DELIVERED]: (event: ChatDeliveredEvent) => void;
  [SERVER_EVENTS.CHAT_MESSAGE_READ]: (event: ChatReadEvent) => void;
  [SERVER_EVENTS.CHAT_TYPING]: (event: ChatTypingEvent) => void;
  [SERVER_EVENTS.CHAT_REACTION]: (event: ChatReactionEvent) => void;
  [SERVER_EVENTS.CALL_INCOMING]: (event: CallIncomingEvent) => void;
  [SERVER_EVENTS.CALL_ANSWERED]: (event: CallAnsweredEvent) => void;
  [SERVER_EVENTS.CALL_DECLINED]: (event: CallDeclinedEvent) => void;
  [SERVER_EVENTS.CALL_ENDED]: (event: CallEndedEvent) => void;
  [SERVER_EVENTS.CALL_REMOTE_OFFER]: (event: CallRemoteOfferEvent) => void;
  [SERVER_EVENTS.CALL_REMOTE_ANSWER]: (event: CallRemoteAnswerEvent) => void;
  [SERVER_EVENTS.CALL_REMOTE_ICE_CANDIDATE]: (event: CallRemoteIceEvent) => void;
  [SERVER_EVENTS.CALL_ERROR]: (event: CallErrorEvent) => void;
  [SERVER_EVENTS.STEWRA_THINKING]: (event: StewraThinkingEvent) => void;
  [SERVER_EVENTS.STEWRA_REPLY]: (event: StewraReplyEvent) => void;
  [SERVER_EVENTS.STEWRA_ERROR]: (event: StewraErrorEvent) => void;
}

export type StewraSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * Resolve the Socket.IO connection target from the API base. The base may be an absolute origin (dev:
 * `http://localhost:3001`) or a same-origin path prefix (prod: `/api`, where nginx proxies `/api/` →
 * backend and strips the prefix). Socket.IO needs the ORIGIN as its connect URL plus an explicit `path`
 * — a bare `io('/api')` would be read as a *namespace* on the page origin with the default `/socket.io/`
 * path, so the handshake would hit the website container, not the backend. Deriving `path` from the base
 * prefix (`/api` → `/api/socket.io/`, `''` → `/socket.io/`) keeps the default `/` namespace and routes
 * the upgrade through nginx to the backend's default `/socket.io/` mount.
 */
function resolveSocketTarget(): { url: string | undefined; path: string } {
  const base = import.meta.env.VITE_WS_BASE_URL ?? BASE_URL;
  const parsed = new URL(base, window.location.origin);
  const prefix = parsed.pathname.replace(/\/+$/, '');
  const path = `${prefix}/socket.io/`;
  // Same-origin (relative base): let Socket.IO use the page origin (pass undefined). Cross-origin (dev):
  // connect to the explicit origin. Either way the default `/` namespace is used.
  const url = parsed.origin === window.location.origin ? undefined : parsed.origin;
  return { url, path };
}

let socket: StewraSocket | null = null;

/**
 * Lazily create (and reuse) the singleton Socket.IO connection, authenticated with the stored access
 * token via the handshake `auth.token` the server's `socketAuthMiddleware` reads. Returns null when no
 * token is stored (the caller isn't logged in — nothing to connect).
 */
export function getSocket(): StewraSocket | null {
  const tokens = readTokens();
  if (!tokens) {
    return null;
  }
  if (socket) {
    return socket;
  }
  const { url, path } = resolveSocketTarget();
  socket = io(url ?? window.location.origin, {
    path,
    auth: { token: tokens.accessToken },
    autoConnect: true,
    transports: ['websocket'],
  });
  return socket;
}

/** Tear down the connection (on logout) so a later login re-handshakes with a fresh token. */
export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
