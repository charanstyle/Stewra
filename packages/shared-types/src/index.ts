// Common
export type { UUID, ISODateString, ApiSuccess, ApiError, ApiResponse, Paginated } from './common/base';

// Models
export type { User, UserRole } from './models/user';
export type { Connection, ConnectionProvider, ConnectionStatus } from './models/connection';
export type {
  MessagingChannel,
  ChannelIdentity,
  ChannelLinkChallenge,
  BridgeWaState,
  BridgeDevice,
} from './models/channel';
export { BRIDGE_WA_STATES } from './models/channel';
export type {
  Suggestion,
  SuggestionKind,
  SuggestionStatus,
  SuggestionOption,
  SuggestionSourceRef,
  ProposedAction,
  ProposedActionType,
} from './models/suggestion';
export type { Briefing, BriefingSection } from './models/briefing';
export type { UserPreferences } from './models/preferences';
export type { Rating, InsightFeedback } from './models/feedback';
export { RATINGS, RATING_REWARD, POSITIVE_RATINGS } from './models/feedback';
export type { AgentMemory, MemorySource } from './models/memory';
export type {
  ProcessRule,
  ProcessDomain,
  ProcessDimension,
  ProcessTier,
  ProcessRuleStatus,
  ProcessRuleSource,
} from './models/processRule';
export { KIND_TO_PROCESS_DOMAIN } from './models/processRule';
export type {
  Contact,
  ContactStatus,
  ContactInvite,
  InviteStatus,
  PublicUser,
  ContactWithUser,
  ContactInviteWithUsers,
} from './models/contact';
export { CONTACT_STATUSES, INVITE_STATUSES } from './models/contact';
export type {
  Conversation,
  ConversationType,
  ParticipantRole,
  PresenceStatus,
  ConversationParticipant,
  ConversationSummary,
} from './models/conversation';
export { CONVERSATION_TYPES } from './models/conversation';
export type {
  Message,
  MessageType,
  MessageStatus,
  SenderKind,
  ReactionType,
  MessageReaction,
  MessagePreview,
  ReadReceipt,
  ProposedEmail,
  ProposedActionStatus,
} from './models/message';
export {
  MESSAGE_TYPES,
  MESSAGE_STATUSES,
  REACTION_TYPES,
  PROPOSED_ACTION_STATUSES,
} from './models/message';
export type {
  CallKind,
  CallStatus,
  CallEndReason,
  RtcSessionDescription,
  RtcIceCandidate,
  CallSession,
  CallParticipant,
} from './models/call';
export { CALL_KINDS } from './models/call';

// API contracts
export type {
  AuthTokens,
  RegisterRequest,
  RegisterResponse,
  LoginRequest,
  LoginResponse,
  RefreshTokenRequest,
  RefreshTokenResponse,
  GetAuthStatusResponse,
} from './api/auth';
export type { ListActivityRequest, ListActivityResponse } from './api/activity';
export type {
  StartCalendarConnectionResponse,
  ConnectionResponse,
  ListConnectionsResponse,
} from './api/connections';
export type {
  GenerateInsightRequest,
  GenerateInsightResponse,
  InsightEngagementResponse,
} from './api/insights';
export type { SubmitFeedbackRequest, SubmitFeedbackResponse } from './api/feedback';
export type { GetBriefingResponse } from './api/briefing';
export type {
  ListSuggestionsResponse,
  SnoozeSuggestionRequest,
  SnoozeSuggestionResponse,
  DismissSuggestionResponse,
  MarkSuggestionDoneResponse,
  RequestDraftRequest,
  RequestDraftResponse,
  ChatAboutSuggestionRequest,
  ChatAboutSuggestionResponse,
} from './api/suggestions';
export type {
  ListMemoriesRequest,
  ListMemoriesResponse,
  UpdateMemoryRequest,
  UpdateMemoryResponse,
  DeleteMemoryResponse,
} from './api/memory';
export type {
  ListProcessRulesRequest,
  ListProcessRulesResponse,
  CreateProcessRuleRequest,
  CreateProcessRuleResponse,
  UpdateProcessRuleRequest,
  UpdateProcessRuleResponse,
  DeleteProcessRuleResponse,
} from './api/processRules';
export {
  GMAIL_LOOKBACK_MIN_DAYS,
  GMAIL_LOOKBACK_MAX_DAYS,
  CALENDAR_LOOKAHEAD_MIN_DAYS,
  CALENDAR_LOOKAHEAD_MAX_DAYS,
} from './api/insights';
export type {
  VerifyEmailRequest,
  VerifyEmailResponse,
  ResendVerificationResponse,
} from './api/emailVerification';
export { EMAIL_VERIFICATION_CODE_LENGTH } from './api/emailVerification';
export type {
  RequestPasswordResetRequest,
  RequestPasswordResetResponse,
  ConfirmPasswordResetRequest,
  ConfirmPasswordResetResponse,
} from './api/passwordReset';
export {
  PASSWORD_RESET_CODE_LENGTH,
  PASSWORD_RESET_MIN_PASSWORD_LENGTH,
} from './api/passwordReset';
export type {
  GetPreferencesResponse,
  UpdatePreferencesRequest,
  UpdatePreferencesResponse,
} from './api/preferences';
export type {
  SearchUsersRequest,
  SearchUsersResponse,
  ListContactsResponse,
  SendInviteRequest,
  SendInviteResponse,
  ListInvitesResponse,
  RespondInviteRequest,
  RespondInviteResponse,
  BlockContactRequest,
  BlockContactResponse,
} from './api/contacts';
export type {
  CreateConversationRequest,
  CreateConversationResponse,
  ListConversationsResponse,
  GetConversationResponse,
  GetStewraConversationResponse,
  AddParticipantsRequest,
  AddParticipantsResponse,
  LeaveConversationResponse,
  MarkReadRequest,
  MarkReadResponse,
} from './api/conversations';
export type {
  SendMessageRequest,
  SendMessageResponse,
  ListMessagesRequest,
  ListMessagesResponse,
  ReactRequest,
  ReactResponse,
  DeleteMessageResponse,
  SendVoiceMessageResponse,
  SendMediaMessageResponse,
  ListReadReceiptsResponse,
  ConfirmEmailAction,
  ConfirmEmailRequest,
  ConfirmEmailResponse,
} from './api/messages';
export type { UploadAvatarResponse } from './api/avatar';
export type {
  GrantWhatsappPersonalConsentRequest,
  GrantWhatsappPersonalConsentResponse,
  StartBridgePairingResponse,
  ClaimBridgeTokenRequest,
  ClaimBridgeTokenResponse,
  ListBridgeDevicesResponse,
  RevokeBridgeDeviceResponse,
  GetWhatsappPersonalResponse,
} from './api/channels';
export {
  WHATSAPP_PERSONAL_CONSENT_VERSION,
  WHATSAPP_PERSONAL_CONSENT_SENTENCE,
  normalizeConsentSentence,
  isConsentSentenceValid,
} from './api/channels';
export type {
  IceServerConfig,
  TurnCredentialsResponse,
  CallPushPlatform,
  RegisterCallPushTokenRequest,
  RegisterCallPushTokenResponse,
  ListCallHistoryResponse,
} from './api/calls';

// Realtime (Socket.IO) contract
export { CLIENT_EVENTS, SERVER_EVENTS } from './realtime/events';
export type { ClientEvent, ServerEvent } from './realtime/events';
export type {
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
  StewraReplyChunkEvent,
  StewraErrorEvent,
} from './realtime/payloads';

// Realtime — the /bridge namespace (Stewra Bridge on the user's own machine)
export { BRIDGE_CLIENT_EVENTS, BRIDGE_SERVER_EVENTS } from './realtime/bridge';
export type {
  BridgeClientEvent,
  BridgeServerEvent,
  BridgeHelloPayload,
  BridgeStatePayload,
  BridgeInboundPayload,
  BridgeAllowedChat,
  BridgeAllowedChatsPayload,
  BridgeSendPayload,
  BridgeSendAck,
} from './realtime/bridge';

// Audit
export type { AuditResourceType, AuditAction, AuditEvent, NewAuditEvent } from './audit/events';

// Broker (the two-plane access contract)
export type {
  ResourceKind,
  BrokerRequest,
  BrokerResult,
  IBrokerClient,
  ModelMessage,
  ConversationTurn,
  IModelClient,
  AgentInsight,
} from './broker/contract';
