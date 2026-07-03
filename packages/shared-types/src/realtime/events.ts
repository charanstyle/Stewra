/**
 * The single source of truth for Socket.IO event names, shared verbatim by the server handlers and
 * every client. Grouped by domain: presence, chat, calls, and stewra-voice. Keeping the strings here
 * (not scattered literals) means a rename is one edit and the client/server can never drift.
 *
 * These are plain `as const` objects (runtime values), so they are exported as VALUES from the barrel,
 * while the derived `ClientEvent`/`ServerEvent` unions are exported as types.
 */

/** Events the client SENDS to the server. */
export const CLIENT_EVENTS = {
  // presence
  PRESENCE_SUBSCRIBE: 'presence:subscribe',
  // chat (ephemeral — persistence happens over REST)
  CHAT_JOIN: 'chat:join',
  CHAT_LEAVE: 'chat:leave',
  CHAT_TYPING: 'chat:typing',
  CHAT_MARK_READ: 'chat:mark-read',
  // calls
  CALL_INITIATE: 'call:initiate',
  CALL_ANSWER: 'call:answer',
  CALL_DECLINE: 'call:decline',
  CALL_END: 'call:end',
  CALL_OFFER: 'call:offer',
  CALL_ANSWER_SDP: 'call:answer-sdp',
  CALL_ICE_CANDIDATE: 'call:ice-candidate',
} as const;
export type ClientEvent = (typeof CLIENT_EVENTS)[keyof typeof CLIENT_EVENTS];

/** Events the server EMITS to clients. */
export const SERVER_EVENTS = {
  // presence
  PRESENCE_UPDATE: 'presence:update',
  // chat
  CHAT_MESSAGE: 'chat:message',
  CHAT_MESSAGE_DELIVERED: 'chat:message-delivered',
  CHAT_MESSAGE_READ: 'chat:message-read',
  CHAT_TYPING: 'chat:typing',
  CHAT_REACTION: 'chat:reaction',
  // calls
  CALL_INCOMING: 'call:incoming',
  CALL_ANSWERED: 'call:answered',
  CALL_DECLINED: 'call:declined',
  CALL_ENDED: 'call:ended',
  CALL_REMOTE_OFFER: 'call:remote-offer',
  CALL_REMOTE_ANSWER: 'call:remote-answer',
  CALL_REMOTE_ICE_CANDIDATE: 'call:remote-ice-candidate',
  CALL_ERROR: 'call:error',
  // stewra-voice
  STEWRA_THINKING: 'stewra:thinking',
  STEWRA_REPLY: 'stewra:reply',
  /** The assistant turn failed to generate — clears the thinking indicator, shows a retryable notice. */
  STEWRA_ERROR: 'stewra:error',
  /** Reserved for a future streaming upgrade (Anthropic SDK path); unused in the non-streaming v1. */
  STEWRA_REPLY_CHUNK: 'stewra:reply-chunk',
} as const;
export type ServerEvent = (typeof SERVER_EVENTS)[keyof typeof SERVER_EVENTS];
