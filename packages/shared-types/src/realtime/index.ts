/** Barrel for the realtime (Socket.IO) contract: event-name constants + strict payload shapes. */

export { CLIENT_EVENTS, SERVER_EVENTS } from './events';
export type { ClientEvent, ServerEvent } from './events';

export type {
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
  StewraReplyChunkEvent,
  StewraErrorEvent,
} from './payloads';
