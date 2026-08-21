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
  RequestPasswordResetRequest,
  RequestPasswordResetResponse,
  ConfirmPasswordResetRequest,
  ConfirmPasswordResetResponse,
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
  ConfirmEmailRequest,
  ConfirmEmailResponse,
  ConfirmCommerceReplyRequest,
  ConfirmCommerceReplyResponse,
  ConfirmRunnerSessionRequest,
  ConfirmRunnerSessionResponse,
  GetMessageResponse,
  DeleteMessageResponse,
  SendVoiceMessageResponse,
  ListReadReceiptsResponse,
  UploadAvatarResponse,
  DeleteAccountRequest,
  DeleteAccountResponse,
  GetAccountDeletionPreviewResponse,
  GetPreferencesResponse,
  UpdatePreferencesRequest,
  UpdatePreferencesResponse,
  TurnCredentialsResponse,
  RegisterCallPushTokenRequest,
  RegisterCallPushTokenResponse,
  ListCallHistoryResponse,
  RegisterPushTokenRequest,
  RegisterPushTokenResponse,
  GetEmailOverWhatsappResponse,
  SetEmailOverWhatsappRequest,
  SetEmailOverWhatsappResponse,
  CreateOrgRequest,
  ConvertOrgRequest,
  ConvertOrgResponse,
  CreateOrgResponse,
  ListOrgsResponse,
  SetActiveOrgRequest,
  SetActiveOrgResponse,
  ListChannelAccountsResponse,
  ListCommerceConversationsRequest,
  ListCommerceConversationsResponse,
  ListCommerceMessagesRequest,
  ListCommerceMessagesResponse,
  CreateCommerceMessageRequest,
  CreateCommerceMessageResponse,
  ListMessageTemplatesResponse,
  ListBroadcastsResponse,
  CancelBroadcastResponse,
  ResumeBroadcastResponse,
  ListCommerceJobsResponse,
  GetOrgBillingResponse,
  ClaimStorePurchaseRequest,
  ClaimStorePurchaseResponse,
  ListActivityResponse,
  ListConnectionsResponse,
  StartCalendarConnectionResponse,
  ConnectionResponse,
  GenerateInsightRequest,
  GenerateInsightResponse,
  SubmitFeedbackRequest,
  SubmitFeedbackResponse,
  InsightEngagementResponse,
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
/**
 * `File.downloadFileAsync` writes the response body to disk regardless of HTTP status, so a failed
 * media GET (401/403/404) leaves the API's JSON error envelope cached under the asset's stable
 * filename — and the plain `exists` short-circuit would then serve that poison forever, so the image
 * silently falls back to initials and never self-heals. Guard against it generically: our API only
 * ever returns a JSON object (`{…}`) on failure, and no real media file (jpeg `FF D8`, png `89 50`,
 * webp `RIFF`, wav `RIFF`, mp4 `…ftyp`) ever begins with `{`. Only small files are byte-scanned so a
 * large legitimate clip is never read into memory just to validate it.
 */
async function isPoisonedMediaFile(file: File): Promise<boolean> {
  if (!file.exists) return true;
  const size = file.size ?? 0;
  if (size === 0) return true;
  if (size >= 4096) return false; // too big to be an error envelope — real media, keep it
  const bytes = await file.bytes();
  let i = 0;
  while (
    i < bytes.length &&
    (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)
  ) {
    i += 1;
  }
  return bytes[i] === 0x7b; // '{' — a JSON API error body, not media
}

export async function fetchAuthedMediaFile(mediaUrl: string, mediaId: string): Promise<string> {
  const destination = new File(Paths.cache, `stewra-media-${mediaId}`);
  if (destination.exists) {
    if (!(await isPoisonedMediaFile(destination))) {
      return destination.uri;
    }
    // Clear a stale error body cached by an earlier failed fetch so this attempt can self-heal.
    destination.delete();
  }

  const tokens = await readTokens();
  const headers: Record<string, string> = {};
  if (tokens) {
    headers['Authorization'] = `Bearer ${tokens.accessToken}`;
  }
  const url = mediaUrl.startsWith('http') ? mediaUrl : `${config.apiBaseUrl}${mediaUrl}`;
  try {
    const downloaded = await File.downloadFileAsync(url, destination, { headers });
    if (await isPoisonedMediaFile(downloaded)) {
      if (downloaded.exists) downloaded.delete();
      throw new ApiError('Media response was not a valid file', 'MEDIA_FETCH_FAILED');
    }
    return downloaded.uri;
  } catch (error) {
    if (destination.exists) destination.delete();
    if (error instanceof ApiError) throw error;
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

  requestPasswordReset: (
    body: RequestPasswordResetRequest,
  ): Promise<RequestPasswordResetResponse> =>
    request('/auth/password-reset/request', { method: 'POST', body, auth: false }),

  confirmPasswordReset: (
    body: ConfirmPasswordResetRequest,
  ): Promise<ConfirmPasswordResetResponse> =>
    request('/auth/password-reset/confirm', { method: 'POST', body, auth: false }),

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

  /** One message by id. Used by the push approval screen, which only receives a messageId. */
  getMessage: (messageId: string): Promise<GetMessageResponse> => request(`/messages/${messageId}`),

  /** Confirm (send) or dismiss (cancel) an email Stewra proposed on an assistant message. */
  confirmEmail: (messageId: string, body: ConfirmEmailRequest): Promise<ConfirmEmailResponse> =>
    request(`/messages/${messageId}/confirm-email`, { method: 'POST', body }),

  /** Confirm (start) or dismiss (cancel) a coding-agent runner session Stewra proposed on a message. */
  confirmRunnerSession: (
    messageId: string,
    body: ConfirmRunnerSessionRequest,
  ): Promise<ConfirmRunnerSessionResponse> =>
    request(`/messages/${messageId}/confirm-runner-session`, { method: 'POST', body }),

  /**
   * Confirm (send) or dismiss (cancel) a reply Stewra proposed to one of the user's business
   * CUSTOMERS. The app's Send button and a natural-language "yes" in chat both land on this same
   * confirm-gated executor — Stewra never sends to a customer on its own.
   */
  confirmCommerceReply: (
    messageId: string,
    body: ConfirmCommerceReplyRequest,
  ): Promise<ConfirmCommerceReplyResponse> =>
    request(`/messages/${messageId}/confirm-commerce-reply`, { method: 'POST', body }),

  /** Per-participant read acknowledgements for one message (drives the read-receipt detail view). */
  listMessageReceipts: (messageId: string): Promise<ListReadReceiptsResponse> =>
    request(`/messages/${messageId}/receipts`),

  // --- Activity + connections (mirrors the website's ActivityPage wrappers) ---

  listActivity: (): Promise<ListActivityResponse> => request('/activity'),

  listConnections: (): Promise<ListConnectionsResponse> => request('/connections'),

  startGoogleConnection: (): Promise<StartCalendarConnectionResponse> =>
    request('/connections/google/start', { method: 'POST', body: {} }),

  disconnect: (id: string): Promise<ConnectionResponse> =>
    request(`/connections/${id}/disconnect`, { method: 'POST', body: {} }),

  // --- Insights ---

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

  /** Manual refresh: sync mail + bank data, rebuild the briefing. Refused (409) while paused. */
  recomputeToday: (): Promise<GetBriefingResponse> =>
    request('/home/recompute', { method: 'POST', body: {} }),

  getPreferences: (): Promise<GetPreferencesResponse> => request('/preferences'),

  updatePreferences: (body: UpdatePreferencesRequest): Promise<UpdatePreferencesResponse> =>
    request('/preferences', { method: 'PATCH', body }),

  /** What deleting this account would do, and anything blocking it. Reads only — destroys nothing. */
  getAccountDeletionPreview: (): Promise<GetAccountDeletionPreviewResponse> =>
    request('/users/me/deletion-preview'),

  /**
   * Permanently delete the account. Irreversible, and the session is dead the moment it returns —
   * the caller must clear its tokens and send the user back to the sign-in screen.
   */
  deleteAccount: (body: DeleteAccountRequest): Promise<DeleteAccountResponse> =>
    request('/users/me', { method: 'DELETE', body }),

  /** Multipart avatar upload: a single `avatar` image file field. Returns the new `/media/:id` URL. */
  uploadAvatar: (imageUri: string, fileName: string, mimeType: string): Promise<UploadAvatarResponse> => {
    const formData = new FormData();
    formData.append('avatar', {
      uri: imageUri,
      name: fileName,
      type: mimeType,
    });
    return request('/users/me/avatar', { method: 'POST', formData });
  },

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

  /**
   * Register this device's EXPO push token — the actionable-notification path (approve-to-send email).
   * Distinct from `registerCallPushToken`, which registers the native VoIP token for the call ring.
   */
  registerPushToken: (body: RegisterPushTokenRequest): Promise<RegisterPushTokenResponse> =>
    request('/push/token', { method: 'PUT', body }),

  /** Whether approve-to-send email over WhatsApp is available and whether this user has it on. */
  getEmailOverWhatsapp: (): Promise<GetEmailOverWhatsappResponse> =>
    request('/channels/whatsapp-email-approval'),

  /**
   * Turn approve-to-send on or off. Enabling requires the account password (re-verified server-side);
   * disabling deliberately does not — removing a capability must never be harder than adding it.
   */
  setEmailOverWhatsapp: (body: SetEmailOverWhatsappRequest): Promise<SetEmailOverWhatsappResponse> =>
    request('/channels/whatsapp-email-approval', { method: 'POST', body }),

  // --- Commerce plane — the mobile FALLBACK surface for a user's business ---
  //
  // Texting Stewra is the headline control; these exist for what a chat thread is bad at: the shared
  // customer inbox and campaign status at a glance. Connecting a channel stays on the website —
  // Meta's Embedded Signup is a browser dialog.

  listOrgs: (): Promise<ListOrgsResponse> => request('/orgs'),

  /**
   * Create an organization; the caller becomes its owner. Slug is omitted deliberately — the server
   * derives it from the name and resolves collisions by suffixing, so a phone keyboard never has to
   * produce a URL-safe handle or retry on a taken one.
   */
  /** An individual org becomes a business one, under a company name. Owner only. */
  convertOrg: (orgId: string, body: ConvertOrgRequest): Promise<ConvertOrgResponse> =>
    request(`/orgs/${orgId}/convert`, { method: 'POST', body }),

  createOrg: (body: CreateOrgRequest): Promise<CreateOrgResponse> =>
    request('/orgs', { method: 'POST', body }),

  /** Which org texting Stewra acts on. Per-user, not per-device — a WhatsApp text has no tab. */
  setActiveOrg: (body: SetActiveOrgRequest): Promise<SetActiveOrgResponse> =>
    request('/orgs/active', { method: 'PUT', body }),

  listChannelAccounts: (orgId: string): Promise<ListChannelAccountsResponse> =>
    request(`/orgs/${orgId}/channels`),

  listCommerceConversations: (
    orgId: string,
    params: ListCommerceConversationsRequest = {},
  ): Promise<ListCommerceConversationsResponse> => {
    // `append`, not `set`: React Native's URLSearchParams typing predates `set`.
    const query = new URLSearchParams();
    if (params.limit !== undefined) query.append('limit', String(params.limit));
    if (params.cursor !== undefined) query.append('cursor', params.cursor);
    const suffix = query.toString();
    return request(`/orgs/${orgId}/conversations${suffix ? `?${suffix}` : ''}`);
  },

  listCommerceMessages: (
    orgId: string,
    conversationId: string,
    params: ListCommerceMessagesRequest = {},
  ): Promise<ListCommerceMessagesResponse> => {
    const query = new URLSearchParams();
    if (params.limit !== undefined) query.append('limit', String(params.limit));
    if (params.cursor !== undefined) query.append('cursor', params.cursor);
    const suffix = query.toString();
    return request(
      `/orgs/${orgId}/conversations/${conversationId}/messages${suffix ? `?${suffix}` : ''}`,
    );
  },

  sendCommerceMessage: (
    orgId: string,
    conversationId: string,
    body: CreateCommerceMessageRequest,
  ): Promise<CreateCommerceMessageResponse> =>
    request(`/orgs/${orgId}/conversations/${conversationId}/messages`, { method: 'POST', body }),

  listMessageTemplates: (orgId: string): Promise<ListMessageTemplatesResponse> =>
    request(`/orgs/${orgId}/templates`),

  listBroadcasts: (orgId: string): Promise<ListBroadcastsResponse> =>
    request(`/orgs/${orgId}/broadcasts`),

  cancelBroadcast: (orgId: string, broadcastId: string): Promise<CancelBroadcastResponse> =>
    request(`/orgs/${orgId}/broadcasts/${broadcastId}/cancel`, { method: 'POST', body: {} }),

  resumeBroadcast: (orgId: string, broadcastId: string): Promise<ResumeBroadcastResponse> =>
    request(`/orgs/${orgId}/broadcasts/${broadcastId}/resume`, { method: 'POST', body: {} }),

  listCommerceJobs: (orgId: string): Promise<ListCommerceJobsResponse> =>
    request(`/orgs/${orgId}/jobs?limit=20`),

  /** What plan the org is on, who bills it, and what the stores say about it. Admin-gated. */
  getOrgBilling: (orgId: string): Promise<GetOrgBillingResponse> =>
    request(`/orgs/${orgId}/billing`),

  /**
   * Report an in-app purchase to the server, which then asks the store what it actually is.
   *
   * The body carries a REFERENCE and nothing else — no product, no price, no expiry, no receipt.
   * That is the contract, not an omission: everything written server-side comes from Apple's or
   * Play's own API, so this call cannot describe a purchase, only name one.
   */
  claimStorePurchase: (
    orgId: string,
    body: ClaimStorePurchaseRequest,
  ): Promise<ClaimStorePurchaseResponse> =>
    request(`/orgs/${orgId}/billing/store-purchase`, { method: 'POST', body }),
};
