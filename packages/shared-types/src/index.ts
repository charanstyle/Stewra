// Common
export type { UUID, ISODateString, ApiSuccess, ApiError, ApiResponse, Paginated } from './common/base';

// Models
export type { User, UserRole } from './models/user';
export type { Connection, ConnectionProvider, ConnectionStatus } from './models/connection';
export type { UserPreferences } from './models/preferences';

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
export type { GenerateInsightRequest, GenerateInsightResponse } from './api/insights';
export { GMAIL_LOOKBACK_MIN_DAYS, GMAIL_LOOKBACK_MAX_DAYS } from './api/insights';
export type {
  VerifyEmailRequest,
  VerifyEmailResponse,
  ResendVerificationResponse,
} from './api/emailVerification';
export { EMAIL_VERIFICATION_CODE_LENGTH } from './api/emailVerification';
export type {
  GetPreferencesResponse,
  UpdatePreferencesRequest,
  UpdatePreferencesResponse,
} from './api/preferences';

// Audit
export type { AuditResourceType, AuditAction, AuditEvent, NewAuditEvent } from './audit/events';

// Broker (the two-plane access contract)
export type {
  ResourceKind,
  BrokerRequest,
  BrokerResult,
  IBrokerClient,
  ModelMessage,
  IModelClient,
  AgentInsight,
} from './broker/contract';
