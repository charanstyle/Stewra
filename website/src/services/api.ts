import type {
  ApiResponse,
  AuthTokens,
  LoginRequest,
  LoginResponse,
  RegisterRequest,
  RegisterResponse,
  GetAuthStatusResponse,
  ListActivityResponse,
  ListConnectionsResponse,
  ConnectionResponse,
  StartCalendarConnectionResponse,
  GenerateInsightRequest,
  GenerateInsightResponse,
  InsightEngagementResponse,
  GetPreferencesResponse,
  UpdatePreferencesRequest,
  UpdatePreferencesResponse,
  VerifyEmailRequest,
  VerifyEmailResponse,
  ResendVerificationResponse,
  SubmitFeedbackRequest,
  SubmitFeedbackResponse,
  ListMemoriesRequest,
  ListMemoriesResponse,
  UpdateMemoryRequest,
  UpdateMemoryResponse,
  DeleteMemoryResponse,
  ListProcessRulesRequest,
  ListProcessRulesResponse,
  CreateProcessRuleRequest,
  CreateProcessRuleResponse,
  UpdateProcessRuleRequest,
  UpdateProcessRuleResponse,
  DeleteProcessRuleResponse,
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
  MarkReadResponse,
  SendMessageRequest,
  SendMessageResponse,
  ListMessagesResponse,
  ReactRequest,
  ReactResponse,
  DeleteMessageResponse,
  SendVoiceMessageResponse,
  TurnCredentialsResponse,
  ListCallHistoryResponse,
  GetBriefingResponse,
  ListSuggestionsResponse,
  SnoozeSuggestionRequest,
  SnoozeSuggestionResponse,
  DismissSuggestionResponse,
  MarkSuggestionDoneResponse,
  RequestDraftRequest,
  RequestDraftResponse,
  ChatAboutSuggestionRequest,
  ChatAboutSuggestionResponse,
} from '@stewra/shared-types';

export const BASE_URL = import.meta.env.VITE_API_BASE_URL;
if (!BASE_URL) {
  // Fail loud: no hardcoded fallback URL (see the project's no-hardcoding rule).
  throw new Error('VITE_API_BASE_URL is not set — configure website/.env');
}

const TOKEN_KEY = 'stewra.tokens';

/** JSON.parse returns `any`; this narrows it to the caller's type without a cast. */
function parseJson<T>(raw: string): T {
  return JSON.parse(raw);
}

/** The access/refresh pair persisted in localStorage. */
export function readTokens(): AuthTokens | null {
  const raw = localStorage.getItem(TOKEN_KEY);
  if (raw === null) {
    return null;
  }
  try {
    return parseJson<AuthTokens>(raw);
  } catch {
    return null;
  }
}

export function writeTokens(tokens: AuthTokens): void {
  localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
}

export function clearTokens(): void {
  localStorage.removeItem(TOKEN_KEY);
}

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

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (options.auth !== false) {
    const tokens = readTokens();
    if (tokens) {
      headers.Authorization = `Bearer ${tokens.accessToken}`;
    }
  }

  const init: RequestInit = { method: options.method ?? 'GET', headers };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(`${BASE_URL}${path}`, init);

  const payload: ApiResponse<T> = await response.json();
  if (!payload.success) {
    throw new ApiError(payload.error.message, payload.error.code);
  }
  return payload.data;
}

/**
 * Like `request`, but sends a `FormData` body (multipart) — used for the voice/media upload routes.
 * The browser sets the `Content-Type` (with the multipart boundary) itself, so we must NOT set it here.
 */
async function requestMultipart<T>(path: string, form: FormData): Promise<T> {
  const headers: Record<string, string> = {};
  const tokens = readTokens();
  if (tokens) {
    headers.Authorization = `Bearer ${tokens.accessToken}`;
  }
  const response = await fetch(`${BASE_URL}${path}`, { method: 'POST', headers, body: form });

  const payload: ApiResponse<T> = await response.json();
  if (!payload.success) {
    throw new ApiError(payload.error.message, payload.error.code);
  }
  return payload.data;
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

  listActivity: (): Promise<ListActivityResponse> => request('/activity'),

  listConnections: (): Promise<ListConnectionsResponse> => request('/connections'),

  startGoogleConnection: (): Promise<StartCalendarConnectionResponse> =>
    request('/connections/google/start', { method: 'POST', body: {} }),

  disconnect: (id: string): Promise<ConnectionResponse> =>
    request(`/connections/${id}/disconnect`, { method: 'POST', body: {} }),

  generateInsight: (body: GenerateInsightRequest): Promise<GenerateInsightResponse> =>
    request('/insights', { method: 'POST', body }),

  submitFeedback: (
    insightId: string,
    body: SubmitFeedbackRequest,
  ): Promise<SubmitFeedbackResponse> =>
    request(`/insights/${insightId}/feedback`, { method: 'POST', body }),

  /** Impression beacon: record that an insight was shown. First-write-wins, no reward effect. */
  markInsightSeen: (insightId: string): Promise<InsightEngagementResponse> =>
    request(`/insights/${insightId}/seen`, { method: 'POST', body: {} }),

  /** Fired when the user closes an insight without rating it — a weak implicit-negative signal. */
  markInsightDismissed: (insightId: string): Promise<InsightEngagementResponse> =>
    request(`/insights/${insightId}/dismissed`, { method: 'POST', body: {} }),

  listMemories: (params: ListMemoriesRequest = {}): Promise<ListMemoriesResponse> => {
    const query = new URLSearchParams();
    if (params.search !== undefined) {
      query.set('search', params.search);
    }
    if (params.kind !== undefined) {
      query.set('kind', params.kind);
    }
    const suffix = query.toString();
    return request(`/memory${suffix ? `?${suffix}` : ''}`);
  },

  updateMemory: (id: string, body: UpdateMemoryRequest): Promise<UpdateMemoryResponse> =>
    request(`/memory/${id}`, { method: 'PATCH', body }),

  deleteMemory: (id: string): Promise<DeleteMemoryResponse> =>
    request(`/memory/${id}`, { method: 'DELETE' }),

  getPreferences: (): Promise<GetPreferencesResponse> => request('/preferences'),

  updatePreferences: (body: UpdatePreferencesRequest): Promise<UpdatePreferencesResponse> =>
    request('/preferences', { method: 'PATCH', body }),

  listProcessRules: (params: ListProcessRulesRequest = {}): Promise<ListProcessRulesResponse> => {
    const query = new URLSearchParams();
    if (params.domain !== undefined) {
      query.set('domain', params.domain);
    }
    if (params.status !== undefined) {
      query.set('status', params.status);
    }
    if (params.search !== undefined) {
      query.set('search', params.search);
    }
    const suffix = query.toString();
    return request(`/process-rules${suffix ? `?${suffix}` : ''}`);
  },

  createProcessRule: (body: CreateProcessRuleRequest): Promise<CreateProcessRuleResponse> =>
    request('/process-rules', { method: 'POST', body }),

  updateProcessRule: (
    id: string,
    body: UpdateProcessRuleRequest,
  ): Promise<UpdateProcessRuleResponse> =>
    request(`/process-rules/${id}`, { method: 'PATCH', body }),

  deleteProcessRule: (id: string): Promise<DeleteProcessRuleResponse> =>
    request(`/process-rules/${id}`, { method: 'DELETE' }),

  // --- Contacts & invites ---

  searchUsers: (query: string): Promise<SearchUsersResponse> =>
    request(`/contacts/search?query=${encodeURIComponent(query)}`),

  listContacts: (): Promise<ListContactsResponse> => request('/contacts'),

  sendInvite: (body: SendInviteRequest): Promise<SendInviteResponse> =>
    request('/contacts/invite', { method: 'POST', body }),

  listInvites: (): Promise<ListInvitesResponse> => request('/contacts/invites'),

  respondInvite: (
    inviteId: string,
    body: RespondInviteRequest,
  ): Promise<RespondInviteResponse> =>
    request(`/contacts/invites/${inviteId}/respond`, { method: 'POST', body }),

  blockContact: (body: BlockContactRequest): Promise<BlockContactResponse> =>
    request('/contacts/block', { method: 'POST', body }),

  // --- Conversations ---

  createConversation: (
    body: CreateConversationRequest,
  ): Promise<CreateConversationResponse> =>
    request('/conversations', { method: 'POST', body }),

  listConversations: (): Promise<ListConversationsResponse> => request('/conversations'),

  getConversation: (id: string): Promise<GetConversationResponse> =>
    request(`/conversations/${id}`),

  getStewraConversation: (): Promise<GetStewraConversationResponse> =>
    request('/conversations/stewra'),

  markConversationRead: (
    id: string,
    upToMessageId: string,
  ): Promise<MarkReadResponse> =>
    request(`/conversations/${id}/read`, { method: 'POST', body: { upToMessageId } }),

  // --- Messages ---

  sendMessage: (body: SendMessageRequest): Promise<SendMessageResponse> =>
    request('/messages', { method: 'POST', body }),

  listMessages: (
    conversationId: string,
    params: { cursor?: string; limit?: number } = {},
  ): Promise<ListMessagesResponse> => {
    const query = new URLSearchParams({ conversationId });
    if (params.cursor !== undefined) {
      query.set('cursor', params.cursor);
    }
    if (params.limit !== undefined) {
      query.set('limit', String(params.limit));
    }
    return request(`/messages?${query.toString()}`);
  },

  reactToMessage: (id: string, body: ReactRequest): Promise<ReactResponse> =>
    request(`/messages/${id}/react`, { method: 'POST', body }),

  deleteMessage: (id: string): Promise<DeleteMessageResponse> =>
    request(`/messages/${id}`, { method: 'DELETE' }),

  /**
   * Upload a recorded voice clip as a multipart form (field name `audio`). The backend transcribes it
   * (whisper.cpp) and, for the Stewra-AI conversation, also returns the assistant's spoken reply.
   */
  sendVoiceMessage: (
    conversationId: string,
    audio: Blob,
    filename = 'voice.webm',
  ): Promise<SendVoiceMessageResponse> => {
    const form = new FormData();
    form.set('conversationId', conversationId);
    form.set('audio', audio, filename);
    return requestMultipart('/messages/voice', form);
  },

  // --- Calls ---

  getTurnCredentials: (): Promise<TurnCredentialsResponse> =>
    request('/calls/turn-credentials'),

  listCallHistory: (): Promise<ListCallHistoryResponse> => request('/calls/history'),

  // --- Today (briefing + nudges) ---

  getBriefing: (): Promise<GetBriefingResponse> => request('/home/briefing'),

  listSuggestions: (): Promise<ListSuggestionsResponse> => request('/home/suggestions'),

  snoozeSuggestion: (
    id: string,
    body: SnoozeSuggestionRequest,
  ): Promise<SnoozeSuggestionResponse> =>
    request(`/home/suggestions/${id}/snooze`, { method: 'POST', body }),

  dismissSuggestion: (id: string): Promise<DismissSuggestionResponse> =>
    request(`/home/suggestions/${id}/dismiss`, { method: 'POST', body: {} }),

  markSuggestionDone: (id: string): Promise<MarkSuggestionDoneResponse> =>
    request(`/home/suggestions/${id}/done`, { method: 'POST', body: {} }),

  /** Read-only: returns draft text for review, never sends. */
  requestDraft: (id: string, body: RequestDraftRequest): Promise<RequestDraftResponse> =>
    request(`/home/suggestions/${id}/draft`, { method: 'POST', body }),

  chatAboutSuggestion: (
    id: string,
    body: ChatAboutSuggestionRequest,
  ): Promise<ChatAboutSuggestionResponse> =>
    request(`/home/suggestions/${id}/chat`, { method: 'POST', body }),
};

/**
 * Fetch an authenticated `/media/:id` asset and return an object URL for playback in an
 * `<audio>`/`<img>` element. The caller owns the returned URL and should `URL.revokeObjectURL` it when
 * the element unmounts. `mediaPath` is a message's `audioUrl`/`mediaUrl` (e.g. `/media/<uuid>`).
 */
export async function fetchMediaObjectUrl(mediaPath: string): Promise<string> {
  const tokens = readTokens();
  const headers: Record<string, string> = {};
  if (tokens) {
    headers.Authorization = `Bearer ${tokens.accessToken}`;
  }
  const response = await fetch(`${BASE_URL}${mediaPath}`, { headers });
  if (!response.ok) {
    throw new ApiError(`Failed to load media (${response.status})`, 'MEDIA_FETCH_FAILED');
  }
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}
