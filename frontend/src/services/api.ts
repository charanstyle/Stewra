import type {
  ApiResponse,
  AuthTokens,
  LoginRequest,
  LoginResponse,
  RegisterRequest,
  RegisterResponse,
  GetAuthStatusResponse,
  RefreshTokenRequest,
  RefreshTokenResponse,
  VerifyEmailRequest,
  VerifyEmailResponse,
  ResendVerificationResponse,
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
  CreateConversationRequest,
  CreateConversationResponse,
  ListConversationsResponse,
  GetConversationResponse,
  GetStewraConversationResponse,
  MarkReadRequest,
  MarkReadResponse,
  SendMessageRequest,
  SendMessageResponse,
  ListMessagesResponse,
  ReactRequest,
  ReactResponse,
  DeleteMessageResponse,
  SendVoiceMessageResponse,
  TurnCredentialsResponse,
  RegisterCallPushTokenRequest,
  RegisterCallPushTokenResponse,
  ListCallHistoryResponse,
} from '@stewra/shared-types';
import { File, Paths } from 'expo-file-system';
import { config } from './config';
import { clearTokens, readTokens, writeTokens } from './tokenStore';

/** An error carrying the backend's plain-language message, for display in the UI. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  readonly method?: string;
  readonly body?: unknown;
  readonly auth?: boolean;
  /** Set when the caller already prepared a FormData body (multipart upload). */
  readonly formData?: FormData;
}

let refreshInFlight: Promise<AuthTokens | null> | null = null;

/** Exchange the stored refresh token for a fresh pair, deduped across concurrent 401s. */
async function refreshTokens(): Promise<AuthTokens | null> {
  if (refreshInFlight) {
    return refreshInFlight;
  }
  refreshInFlight = (async (): Promise<AuthTokens | null> => {
    const current = await readTokens();
    if (!current) {
      return null;
    }
    try {
      const body: RefreshTokenRequest = { refreshToken: current.refreshToken };
      const response = await fetch(`${config.apiBaseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload: ApiResponse<RefreshTokenResponse> = await response.json();
      if (!payload.success) {
        await clearTokens();
        return null;
      }
      await writeTokens(payload.data.tokens);
      return payload.data.tokens;
    } catch {
      return null;
    }
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

async function request<T>(path: string, options: RequestOptions = {}, isRetry = false): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (options.auth !== false) {
    const tokens = await readTokens();
    if (tokens) {
      headers['Authorization'] = `Bearer ${tokens.accessToken}`;
    }
  }

  const init: RequestInit = { method: options.method ?? 'GET', headers };
  if (options.formData) {
    init.body = options.formData;
    // Do not set Content-Type: fetch derives the multipart boundary itself.
    delete headers['Content-Type'];
  } else if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }

  const response = await fetch(`${config.apiBaseUrl}${path}`, init);

  if (response.status === 401 && options.auth !== false && !isRetry) {
    const refreshed = await refreshTokens();
    if (refreshed) {
      return request<T>(path, options, true);
    }
  }

  const payload: ApiResponse<T> = await response.json();
  if (!payload.success) {
    throw new ApiError(payload.error.message, payload.error.code);
  }
  return payload.data;
}

/**
 * Fetch an authenticated media asset (GET /media/:id) to a cached local file and
 * return its `file://` URI. React Native audio/video players need a local URI —
 * unlike the web, `fetch().blob()` + `URL.createObjectURL` is not a reliable
 * playback source here — so this downloads once per media id and reuses the
 * cached copy on subsequent calls.
 */
export async function fetchAuthedMediaFile(mediaUrl: string, mediaId: string): Promise<string> {
  const destination = new File(Paths.cache, `stewra-media-${mediaId}`);
  if (destination.exists) {
    return destination.uri;
  }

  const tokens = await readTokens();
  const headers: Record<string, string> = {};
  if (tokens) {
    headers['Authorization'] = `Bearer ${tokens.accessToken}`;
  }
  const url = mediaUrl.startsWith('http') ? mediaUrl : `${config.apiBaseUrl}${mediaUrl}`;
  try {
    const downloaded = await File.downloadFileAsync(url, destination, { headers });
    return downloaded.uri;
  } catch (error) {
    throw new ApiError(
      error instanceof Error ? error.message : 'Failed to fetch media',
      'MEDIA_FETCH_FAILED',
    );
  }
}

export const api = {
  register: (body: RegisterRequest): Promise<RegisterResponse> =>
    request('/auth/register', { method: 'POST', body, auth: false }),

  login: (body: LoginRequest): Promise<LoginResponse> =>
    request('/auth/login', { method: 'POST', body, auth: false }),

  me: (): Promise<GetAuthStatusResponse> => request('/auth/me'),

  verifyEmail: (body: VerifyEmailRequest): Promise<VerifyEmailResponse> =>
    request('/email-verification/verify', { method: 'POST', body }),

  resendVerification: (): Promise<ResendVerificationResponse> =>
    request('/email-verification/resend', { method: 'POST', body: {} }),

  searchUsers: (params: SearchUsersRequest): Promise<SearchUsersResponse> =>
    request(`/contacts/search?query=${encodeURIComponent(params.query)}`),

  listContacts: (): Promise<ListContactsResponse> => request('/contacts'),

  sendInvite: (body: SendInviteRequest): Promise<SendInviteResponse> =>
    request('/contacts/invites', { method: 'POST', body }),

  listInvites: (): Promise<ListInvitesResponse> => request('/contacts/invites'),

  respondInvite: (inviteId: string, body: RespondInviteRequest): Promise<RespondInviteResponse> =>
    request(`/contacts/invites/${inviteId}/respond`, { method: 'POST', body }),

  blockContact: (body: BlockContactRequest): Promise<BlockContactResponse> =>
    request('/contacts/block', { method: 'POST', body }),

  createConversation: (body: CreateConversationRequest): Promise<CreateConversationResponse> =>
    request('/conversations', { method: 'POST', body }),

  listConversations: (): Promise<ListConversationsResponse> => request('/conversations'),

  getConversation: (id: string): Promise<GetConversationResponse> =>
    request(`/conversations/${id}`),

  getStewraConversation: (): Promise<GetStewraConversationResponse> =>
    request('/conversations/stewra'),

  markConversationRead: (id: string, body: MarkReadRequest): Promise<MarkReadResponse> =>
    request(`/conversations/${id}/read`, { method: 'POST', body }),

  sendMessage: (body: SendMessageRequest): Promise<SendMessageResponse> =>
    request('/messages', { method: 'POST', body }),

  listMessages: (conversationId: string, cursor?: string, limit?: number): Promise<ListMessagesResponse> => {
    const parts = [`conversationId=${encodeURIComponent(conversationId)}`];
    if (cursor !== undefined) {
      parts.push(`cursor=${encodeURIComponent(cursor)}`);
    }
    if (limit !== undefined) {
      parts.push(`limit=${encodeURIComponent(String(limit))}`);
    }
    return request(`/messages?${parts.join('&')}`);
  },

  reactToMessage: (messageId: string, body: ReactRequest): Promise<ReactResponse> =>
    request(`/messages/${messageId}/react`, { method: 'POST', body }),

  deleteMessage: (messageId: string): Promise<DeleteMessageResponse> =>
    request(`/messages/${messageId}`, { method: 'DELETE' }),

  /** Multipart voice upload: `audio` file field + `conversationId` text field. */
  sendVoiceMessage: (conversationId: string, audioUri: string, fileName: string, mimeType: string): Promise<SendVoiceMessageResponse> => {
    const formData = new FormData();
    formData.append('conversationId', conversationId);
    formData.append('audio', {
      uri: audioUri,
      name: fileName,
      type: mimeType,
    });
    return request('/messages/voice', { method: 'POST', formData });
  },

  getTurnCredentials: (): Promise<TurnCredentialsResponse> => request('/calls/turn-credentials'),

  registerCallPushToken: (body: RegisterCallPushTokenRequest): Promise<RegisterCallPushTokenResponse> =>
    request('/calls/push-token', { method: 'PUT', body }),

  listCallHistory: (): Promise<ListCallHistoryResponse> => request('/calls/history'),
};
