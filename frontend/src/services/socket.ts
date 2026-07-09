import { io, type Socket } from 'socket.io-client';
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
  CallSession,
} from '@stewra/shared-types';
import type { CLIENT_EVENTS, SERVER_EVENTS } from '@stewra/shared-types';
import { config } from './config';
import { readTokens } from './tokenStore';

/** Ack shape for CLIENT_EVENTS.CALL_INITIATE — the server mints the CallSession id. */
export interface CallInitiateAck {
  readonly ok: boolean;
  readonly call?: CallSession;
  readonly error?: string;
}

/** Ack shape shared by answer/decline/end/offer/answer-sdp/ice acks. */
export interface OkAck {
  readonly ok: boolean;
  readonly error?: string;
}

/** Ack for `presence:subscribe`: the current status of every requested user (for an immediate paint). */
export interface PresenceSubscribeAck {
  readonly ok: boolean;
  readonly statuses: ReadonlyArray<PresenceUpdateEvent>;
}

/** Server → client event payload map, one entry per `SERVER_EVENTS` value. */
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

/** Client → server event payload/ack map, one entry per `CLIENT_EVENTS` value. */
interface ClientToServerEvents {
  [CLIENT_EVENTS.PRESENCE_SUBSCRIBE]: (
    payload: PresenceSubscribePayload,
    ack: (response: PresenceSubscribeAck) => void,
  ) => void;
  [CLIENT_EVENTS.CHAT_JOIN]: (payload: ChatJoinPayload) => void;
  [CLIENT_EVENTS.CHAT_LEAVE]: (payload: ChatJoinPayload) => void;
  [CLIENT_EVENTS.CHAT_TYPING]: (payload: ChatTypingPayload) => void;
  [CLIENT_EVENTS.CHAT_MARK_READ]: (payload: ChatMarkReadPayload) => void;
  [CLIENT_EVENTS.CALL_INITIATE]: (payload: CallInitiatePayload, ack: (response: CallInitiateAck) => void) => void;
  [CLIENT_EVENTS.CALL_ANSWER]: (payload: CallLifecyclePayload, ack: (response: OkAck) => void) => void;
  [CLIENT_EVENTS.CALL_DECLINE]: (payload: CallLifecyclePayload) => void;
  [CLIENT_EVENTS.CALL_END]: (payload: CallLifecyclePayload) => void;
  [CLIENT_EVENTS.CALL_OFFER]: (payload: CallSignalPayload) => void;
  [CLIENT_EVENTS.CALL_ANSWER_SDP]: (payload: CallSignalPayload) => void;
  [CLIENT_EVENTS.CALL_ICE_CANDIDATE]: (payload: CallIcePayload) => void;
}

export type StewraSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * Split the WS base into the origin to connect to and the Socket.IO `path`. In prod the backend's
 * `/socket.io/` mount is fronted by nginx under `/api/`, so a base of `https://host/api` must connect to
 * the origin `https://host` with path `/api/socket.io/` — passing the full base as the connect URL would
 * make Socket.IO treat `/api` as a namespace and default the path to `/socket.io/`, missing the backend.
 * Parsed with a regex rather than `new URL` because React Native lacks a spec-compliant URL. A base with
 * no path prefix (e.g. `http://10.0.2.2:3001`) yields the default `/socket.io/`.
 */
function resolveSocketTarget(base: string): { readonly url: string; readonly path: string } {
  const match = base.match(/^(https?:\/\/[^/]+)(\/.*)?$/i);
  const url = match?.[1] ?? base;
  const prefix = (match?.[2] ?? '').replace(/\/+$/, '');
  return { url, path: `${prefix}/socket.io/` };
}

let socket: StewraSocket | null = null;
let connecting: Promise<StewraSocket> | null = null;

/**
 * Build (once) and connect the Socket.IO singleton, authenticating via
 * `auth: { token }` per the backend handshake contract. Safe to call repeatedly;
 * concurrent callers share one in-flight connection attempt.
 */
export async function connectSocket(): Promise<StewraSocket> {
  if (socket?.connected) {
    return socket;
  }
  if (connecting) {
    return connecting;
  }

  connecting = (async (): Promise<StewraSocket> => {
    const tokens = await readTokens();
    if (!tokens) {
      throw new Error('Cannot connect the realtime socket without an access token');
    }

    const { url, path } = resolveSocketTarget(config.wsBaseUrl);
    const next: StewraSocket =
      socket ??
      io(url, {
        path,
        autoConnect: false,
        transports: ['websocket'],
        auth: { token: tokens.accessToken },
      });
    next.auth = { token: tokens.accessToken };
    socket = next;

    if (!next.connected) {
      await new Promise<void>((resolve, reject) => {
        const onConnect = (): void => {
          next.off('connect_error', onError);
          resolve();
        };
        const onError = (error: Error): void => {
          next.off('connect', onConnect);
          reject(error);
        };
        next.once('connect', onConnect);
        next.once('connect_error', onError);
        next.connect();
      });
    }
    return next;
  })();

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

/** Ensure the socket is connected, refreshing the auth token first. Returns false on failure. */
export async function ensureSocketConnected(): Promise<boolean> {
  try {
    await connectSocket();
    return true;
  } catch {
    return false;
  }
}

export function getSocket(): StewraSocket | null {
  return socket;
}

export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
  }
  socket = null;
  connecting = null;
}
