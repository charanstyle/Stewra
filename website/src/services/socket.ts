import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import {
  CLIENT_EVENTS,
  SERVER_EVENTS,
} from '@stewra/shared-types';
import type {
  PresenceSubscribePayload,
  PresenceUpdateEvent,
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
}

export type StewraSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * WebSocket origin. Defaults to the REST API origin (same host serves both) unless VITE_WS_BASE_URL
 * overrides it. The socket path is external `/socket.io/`; in prod nginx proxies `/api/` → backend and
 * WS upgrades pass through, so we point at the API origin's root.
 */
const WS_BASE_URL = import.meta.env.VITE_WS_BASE_URL ?? BASE_URL;

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
  socket = io(WS_BASE_URL, {
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
