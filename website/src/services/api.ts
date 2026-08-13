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
  ListReadReceiptsResponse,
  ReactRequest,
  ReactResponse,
  DeleteMessageResponse,
  ConfirmEmailRequest,
  ConfirmEmailResponse,
  ConfirmRunnerSessionRequest,
  ConfirmRunnerSessionResponse,
  ConfirmCommerceReplyRequest,
  ConfirmCommerceReplyResponse,
  SendVoiceMessageResponse,
  UploadAvatarResponse,
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
  GetWhatsappPersonalResponse,
  GrantWhatsappPersonalConsentRequest,
  GrantWhatsappPersonalConsentResponse,
  StartBridgePairingResponse,
  RevokeBridgeDeviceResponse,
  GetEmailOverWhatsappResponse,
  SetEmailOverWhatsappRequest,
  SetEmailOverWhatsappResponse,
  // Commerce plane
  ListOrgsResponse,
  CreateOrgRequest,
  CreateOrgResponse,
  SetActiveOrgRequest,
  SetActiveOrgResponse,
  ListOrgMembersResponse,
  CreateOrgInviteRequest,
  CreateOrgInviteResponse,
  AcceptOrgInviteRequest,
  AcceptOrgInviteResponse,
  DeleteOrgInviteResponse,
  UpdateOrgMemberRequest,
  UpdateOrgMemberResponse,
  DeleteOrgMemberResponse,
  ListChannelAccountsResponse,
  CreateChannelAccountRequest,
  CreateChannelAccountResponse,
  DeleteChannelAccountResponse,
  ListCommerceConversationsRequest,
  ListCommerceConversationsResponse,
  ListCommerceMessagesRequest,
  ListCommerceMessagesResponse,
  CreateCommerceMessageRequest,
  CreateCommerceMessageResponse,
  SendConversationTemplateRequest,
  SendConversationTemplateResponse,
  ListCommerceContactsRequest,
  ListCommerceContactsResponse,
  CreateCommerceContactRequest,
  CreateCommerceContactResponse,
  CommercePlatform,
  CreateContactImportResponse,
  CreateOptinLinkRequest,
  CreateOptinLinkResponse,
  ListOptinLinksResponse,
  DisableOptinLinkResponse,
  ListContactImportsResponse,
  GetContactImportResponse,
  GetCommerceContactResponse,
  UpdateCommerceContactRequest,
  UpdateCommerceContactResponse,
  AddContactTagRequest,
  AddContactTagResponse,
  RemoveContactTagResponse,
  ListCommerceTagsResponse,
  DeleteCommerceTagResponse,
  ListCommerceSegmentsResponse,
  CreateCommerceSegmentRequest,
  CreateCommerceSegmentResponse,
  UpdateCommerceSegmentRequest,
  UpdateCommerceSegmentResponse,
  DeleteCommerceSegmentResponse,
  PreviewSegmentRequest,
  PreviewSegmentResponse,
  ListContactConsentsResponse,
  RecordContactConsentRequest,
  RecordContactConsentResponse,
  ListSuppressionsRequest,
  ListSuppressionsResponse,
  CreateSuppressionRequest,
  CreateSuppressionResponse,
  DeleteSuppressionResponse,
  GetMessagingPolicyResponse,
  UpdateMessagingPolicyRequest,
  UpdateMessagingPolicyResponse,
  AttestMessagingPolicyRequest,
  AttestMessagingPolicyResponse,
  ListMessageTemplatesRequest,
  ListMessageTemplatesResponse,
  CreateMessageTemplateRequest,
  CreateMessageTemplateResponse,
  SyncMessageTemplatesRequest,
  SyncMessageTemplatesResponse,
  DeleteMessageTemplateResponse,
  ListBroadcastsResponse,
  CreateBroadcastRequest,
  CreateBroadcastResponse,
  GetBroadcastResponse,
  PreviewBroadcastRequest,
  PreviewBroadcastResponse,
  CancelBroadcastResponse,
  ResumeBroadcastResponse,
  ListBroadcastRecipientsRequest,
  ListBroadcastRecipientsResponse,
  GetCommerceCostsRequest,
  GetCommerceCostsResponse,
  ListCommerceJobsRequest,
  ListCommerceJobsResponse,
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

/**
 * An error carrying the backend's plain-language message, for display in the UI.
 *
 * `message` is composed from `details` when the backend sent any, because a `ValidationError` there
 * carries the fixed string "Validation failed" and puts the reason a human needs — "The PIN is six
 * digits" — in the per-field details. Doing it here rather than at each call site means every
 * `err.message` in the app is legible; there are a dozen `describeError` helpers that would
 * otherwise all have to know this convention.
 */
export class ApiError extends Error {
  constructor(
    serverMessage: string,
    readonly code: string,
    readonly details: ReadonlyArray<{ readonly field: string; readonly message: string }> = [],
  ) {
    super(details.length > 0 ? details.map((d) => d.message).join(' ') : serverMessage);
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
    throw new ApiError(payload.error.message, payload.error.code, payload.error.details);
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
    throw new ApiError(payload.error.message, payload.error.code, payload.error.details);
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
    request('/contacts/invites', { method: 'POST', body }),

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

  /**
   * Confirm (`send`) or dismiss (`cancel`) an email Stewra proposed on an assistant message. The send
   * runs through the trusted confirm-gated executor server-side; the updated message (its
   * `proposedEmail.status` now terminal) comes back so the in-chat card re-renders.
   */
  confirmEmail: (id: string, body: ConfirmEmailRequest): Promise<ConfirmEmailResponse> =>
    request(`/messages/${id}/confirm-email`, { method: 'POST', body }),

  confirmRunnerSession: (
    id: string,
    body: ConfirmRunnerSessionRequest,
  ): Promise<ConfirmRunnerSessionResponse> =>
    request(`/messages/${id}/confirm-runner-session`, { method: 'POST', body }),

  /**
   * Send (`send`) or dismiss (`cancel`) a reply Stewra proposed to one of an organization's customers.
   * Runs the SAME server-side executor a natural-language "yes" does; the updated message (its
   * `proposedCommerceReply.status` now terminal) comes back so the in-chat card re-renders.
   */
  confirmCommerceReply: (
    id: string,
    body: ConfirmCommerceReplyRequest,
  ): Promise<ConfirmCommerceReplyResponse> =>
    request(`/messages/${id}/confirm-commerce-reply`, { method: 'POST', body }),

  /** Per-participant read acknowledgements for one message (drives the read-receipt detail view). */
  listMessageReceipts: (id: string): Promise<ListReadReceiptsResponse> =>
    request(`/messages/${id}/receipts`),

  /** Upload a profile photo as multipart (field `avatar`); returns the new `/media/:id` URL. */
  uploadAvatar: (image: Blob, filename = 'avatar.jpg'): Promise<UploadAvatarResponse> => {
    const form = new FormData();
    form.set('avatar', image, filename);
    return requestMultipart('/users/me/avatar', form);
  },

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

  // --- WhatsApp (personal) — experimental user-hosted bridge ---

  getWhatsappPersonal: (): Promise<GetWhatsappPersonalResponse> =>
    request('/channels/whatsapp-personal'),

  grantWhatsappPersonalConsent: (
    body: GrantWhatsappPersonalConsentRequest,
  ): Promise<GrantWhatsappPersonalConsentResponse> =>
    request('/channels/whatsapp-personal/consent', { method: 'POST', body }),

  startBridgePairing: (): Promise<StartBridgePairingResponse> =>
    request('/channels/whatsapp-personal/pair', { method: 'POST', body: {} }),

  revokeBridgeDevice: (id: string): Promise<RevokeBridgeDeviceResponse> =>
    request(`/channels/whatsapp-personal/devices/${id}`, { method: 'DELETE' }),

  // --- Approve-to-send email over WhatsApp — the per-user opt-in ---

  getEmailOverWhatsapp: (): Promise<GetEmailOverWhatsappResponse> =>
    request('/channels/whatsapp-email-approval'),

  // Turning the opt-in ON carries the account password (re-verified server-side); turning it OFF omits it.
  setEmailOverWhatsapp: (
    body: SetEmailOverWhatsappRequest,
  ): Promise<SetEmailOverWhatsappResponse> =>
    request('/channels/whatsapp-email-approval', { method: 'POST', body }),

  // --- Commerce plane — organizations, connected channels, and the shared inbox ---
  //
  // Everything below `/orgs/:orgId/` is tenant-scoped server-side by `requireOrgMember`. The org id
  // in these paths is a routing detail, not the authorization: passing someone else's returns 404.

  listOrgs: (): Promise<ListOrgsResponse> => request('/orgs'),

  createOrg: (body: CreateOrgRequest): Promise<CreateOrgResponse> =>
    request('/orgs', { method: 'POST', body }),

  /** Which org the CONVERSATIONAL surface acts on. Per-user, not per-tab — a WhatsApp text has no tab. */
  setActiveOrg: (body: SetActiveOrgRequest): Promise<SetActiveOrgResponse> =>
    request('/orgs/active', { method: 'PUT', body }),

  listOrgMembers: (orgId: string): Promise<ListOrgMembersResponse> =>
    request(`/orgs/${orgId}/members`),

  createOrgInvite: (orgId: string, body: CreateOrgInviteRequest): Promise<CreateOrgInviteResponse> =>
    request(`/orgs/${orgId}/invites`, { method: 'POST', body }),

  acceptOrgInvite: (body: AcceptOrgInviteRequest): Promise<AcceptOrgInviteResponse> =>
    request('/orgs/invites/accept', { method: 'POST', body }),

  revokeOrgInvite: (orgId: string, inviteId: string): Promise<DeleteOrgInviteResponse> =>
    request(`/orgs/${orgId}/invites/${inviteId}`, { method: 'DELETE' }),

  updateOrgMember: (
    orgId: string,
    memberId: string,
    body: UpdateOrgMemberRequest,
  ): Promise<UpdateOrgMemberResponse> =>
    request(`/orgs/${orgId}/members/${memberId}`, { method: 'PATCH', body }),

  removeOrgMember: (orgId: string, memberId: string): Promise<DeleteOrgMemberResponse> =>
    request(`/orgs/${orgId}/members/${memberId}`, { method: 'DELETE' }),

  listChannelAccounts: (orgId: string): Promise<ListChannelAccountsResponse> =>
    request(`/orgs/${orgId}/channels`),

  /** Hand the server the one-time code Meta's Embedded Signup returned; it does the rest. */
  connectWhatsappAccount: (
    orgId: string,
    body: CreateChannelAccountRequest,
  ): Promise<CreateChannelAccountResponse> =>
    request(`/orgs/${orgId}/channels/whatsapp`, { method: 'POST', body }),

  disconnectChannelAccount: (
    orgId: string,
    accountId: string,
  ): Promise<DeleteChannelAccountResponse> =>
    request(`/orgs/${orgId}/channels/${accountId}`, { method: 'DELETE' }),

  listCommerceConversations: (
    orgId: string,
    params: ListCommerceConversationsRequest = {},
  ): Promise<ListCommerceConversationsResponse> => {
    const query = new URLSearchParams();
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.cursor !== undefined) query.set('cursor', params.cursor);
    const suffix = query.toString();
    return request(`/orgs/${orgId}/conversations${suffix ? `?${suffix}` : ''}`);
  },

  listCommerceMessages: (
    orgId: string,
    conversationId: string,
    params: ListCommerceMessagesRequest = {},
  ): Promise<ListCommerceMessagesResponse> => {
    const query = new URLSearchParams();
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.cursor !== undefined) query.set('cursor', params.cursor);
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

  sendConversationTemplate: (
    orgId: string,
    conversationId: string,
    body: SendConversationTemplateRequest,
  ): Promise<SendConversationTemplateResponse> =>
    request(`/orgs/${orgId}/conversations/${conversationId}/template-messages`, {
      method: 'POST',
      body,
    }),

  // --- Commerce audience — contacts, tags, segments ---

  listCommerceContacts: (
    orgId: string,
    params: ListCommerceContactsRequest = {},
  ): Promise<ListCommerceContactsResponse> => {
    const query = new URLSearchParams();
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.search !== undefined) query.set('search', params.search);
    if (params.tag !== undefined) query.set('tag', params.tag);
    const suffix = query.toString();
    return request(`/orgs/${orgId}/contacts${suffix ? `?${suffix}` : ''}`);
  },

  createCommerceContact: (
    orgId: string,
    body: CreateCommerceContactRequest,
  ): Promise<CreateCommerceContactResponse> =>
    request(`/orgs/${orgId}/contacts`, { method: 'POST', body }),

  /**
   * Upload a contact list. Multipart, because the file is the request — see
   * `CreateContactImportResponse` for the columns it must carry.
   *
   * Answers 202 with an import that has not run yet. The contacts appear only after
   * `getContactImport` reports `done`, which is why the caller polls rather than reloading the list.
   */
  createContactImport: (
    orgId: string,
    file: File,
    platform?: CommercePlatform,
  ): Promise<CreateContactImportResponse> => {
    const form = new FormData();
    form.append('file', file);
    if (platform !== undefined) form.append('platform', platform);
    return requestMultipart(`/orgs/${orgId}/contacts/import`, form);
  },

  listContactImports: (orgId: string): Promise<ListContactImportsResponse> =>
    request(`/orgs/${orgId}/contacts/imports`),

  getContactImport: (orgId: string, importId: string): Promise<GetContactImportResponse> =>
    request(`/orgs/${orgId}/contacts/imports/${importId}`),

  /**
   * Mint a click-to-WhatsApp opt-in link. The server appends the reference code to `phrase` and
   * returns the finished `wa.me` URL — the caller must not build one, or the token that identifies
   * the link on the way back would be missing.
   */
  createOptinLink: (
    orgId: string,
    body: CreateOptinLinkRequest,
  ): Promise<CreateOptinLinkResponse> =>
    request(`/orgs/${orgId}/optin-links`, { method: 'POST', body }),

  listOptinLinks: (orgId: string): Promise<ListOptinLinksResponse> =>
    request(`/orgs/${orgId}/optin-links`),

  /** Stop honouring a link. The opt-ins it already gathered stay, and stay attributed to it. */
  disableOptinLink: (orgId: string, linkId: string): Promise<DisableOptinLinkResponse> =>
    request(`/orgs/${orgId}/optin-links/${linkId}/disable`, { method: 'POST' }),

  getCommerceContact: (orgId: string, contactId: string): Promise<GetCommerceContactResponse> =>
    request(`/orgs/${orgId}/contacts/${contactId}`),

  updateCommerceContact: (
    orgId: string,
    contactId: string,
    body: UpdateCommerceContactRequest,
  ): Promise<UpdateCommerceContactResponse> =>
    request(`/orgs/${orgId}/contacts/${contactId}`, { method: 'PATCH', body }),

  addContactTag: (
    orgId: string,
    contactId: string,
    body: AddContactTagRequest,
  ): Promise<AddContactTagResponse> =>
    request(`/orgs/${orgId}/contacts/${contactId}/tags`, { method: 'POST', body }),

  removeContactTag: (
    orgId: string,
    contactId: string,
    tagId: string,
  ): Promise<RemoveContactTagResponse> =>
    request(`/orgs/${orgId}/contacts/${contactId}/tags/${tagId}`, { method: 'DELETE' }),

  listCommerceTags: (orgId: string): Promise<ListCommerceTagsResponse> =>
    request(`/orgs/${orgId}/tags`),

  deleteCommerceTag: (orgId: string, tagId: string): Promise<DeleteCommerceTagResponse> =>
    request(`/orgs/${orgId}/tags/${tagId}`, { method: 'DELETE' }),

  listCommerceSegments: (orgId: string): Promise<ListCommerceSegmentsResponse> =>
    request(`/orgs/${orgId}/segments`),

  createCommerceSegment: (
    orgId: string,
    body: CreateCommerceSegmentRequest,
  ): Promise<CreateCommerceSegmentResponse> =>
    request(`/orgs/${orgId}/segments`, { method: 'POST', body }),

  updateCommerceSegment: (
    orgId: string,
    segmentId: string,
    body: UpdateCommerceSegmentRequest,
  ): Promise<UpdateCommerceSegmentResponse> =>
    request(`/orgs/${orgId}/segments/${segmentId}`, { method: 'PUT', body }),

  deleteCommerceSegment: (
    orgId: string,
    segmentId: string,
  ): Promise<DeleteCommerceSegmentResponse> =>
    request(`/orgs/${orgId}/segments/${segmentId}`, { method: 'DELETE' }),

  /** What a rule would reach RIGHT NOW — totals, per-reason blocks, and a sample. */
  previewCommerceSegment: (
    orgId: string,
    body: PreviewSegmentRequest,
  ): Promise<PreviewSegmentResponse> =>
    request(`/orgs/${orgId}/segments/preview`, { method: 'POST', body }),

  // --- Commerce consent — the permission layer every broadcast passes through ---

  listContactConsents: (
    orgId: string,
    contactId: string,
  ): Promise<ListContactConsentsResponse> =>
    request(`/orgs/${orgId}/contacts/${contactId}/consents`),

  recordContactConsent: (
    orgId: string,
    contactId: string,
    body: RecordContactConsentRequest,
  ): Promise<RecordContactConsentResponse> =>
    request(`/orgs/${orgId}/contacts/${contactId}/consents`, { method: 'POST', body }),

  listSuppressions: (
    orgId: string,
    params: ListSuppressionsRequest = {},
  ): Promise<ListSuppressionsResponse> => {
    const query = new URLSearchParams();
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    const suffix = query.toString();
    return request(`/orgs/${orgId}/suppressions${suffix ? `?${suffix}` : ''}`);
  },

  createSuppression: (
    orgId: string,
    body: CreateSuppressionRequest,
  ): Promise<CreateSuppressionResponse> =>
    request(`/orgs/${orgId}/suppressions`, { method: 'POST', body }),

  deleteSuppression: (
    orgId: string,
    platform: string,
    externalId: string,
  ): Promise<DeleteSuppressionResponse> =>
    request(`/orgs/${orgId}/suppressions/${platform}/${encodeURIComponent(externalId)}`, {
      method: 'DELETE',
    }),

  getMessagingPolicy: (orgId: string): Promise<GetMessagingPolicyResponse> =>
    request(`/orgs/${orgId}/messaging-policy`),

  updateMessagingPolicy: (
    orgId: string,
    body: UpdateMessagingPolicyRequest,
  ): Promise<UpdateMessagingPolicyResponse> =>
    request(`/orgs/${orgId}/messaging-policy`, { method: 'PUT', body }),

  attestMessagingPolicy: (
    orgId: string,
    body: AttestMessagingPolicyRequest,
  ): Promise<AttestMessagingPolicyResponse> =>
    request(`/orgs/${orgId}/messaging-policy/attestation`, { method: 'POST', body }),

  // --- Commerce campaigns — templates, broadcasts, costs, and the job queue ---

  listMessageTemplates: (
    orgId: string,
    params: ListMessageTemplatesRequest = {},
  ): Promise<ListMessageTemplatesResponse> => {
    const query = new URLSearchParams();
    if (params.channelAccountId !== undefined) {
      query.set('channelAccountId', params.channelAccountId);
    }
    const suffix = query.toString();
    return request(`/orgs/${orgId}/templates${suffix ? `?${suffix}` : ''}`);
  },

  createMessageTemplate: (
    orgId: string,
    body: CreateMessageTemplateRequest,
  ): Promise<CreateMessageTemplateResponse> =>
    request(`/orgs/${orgId}/templates`, { method: 'POST', body }),

  /** Re-read one account's templates from Meta, for whoever cannot wait for the hourly sync. */
  syncMessageTemplates: (
    orgId: string,
    body: SyncMessageTemplatesRequest,
  ): Promise<SyncMessageTemplatesResponse> =>
    request(`/orgs/${orgId}/templates/sync`, { method: 'POST', body }),

  deleteMessageTemplate: (
    orgId: string,
    templateId: string,
  ): Promise<DeleteMessageTemplateResponse> =>
    request(`/orgs/${orgId}/templates/${templateId}`, { method: 'DELETE' }),

  listBroadcasts: (orgId: string): Promise<ListBroadcastsResponse> =>
    request(`/orgs/${orgId}/broadcasts`),

  createBroadcast: (orgId: string, body: CreateBroadcastRequest): Promise<CreateBroadcastResponse> =>
    request(`/orgs/${orgId}/broadcasts`, { method: 'POST', body }),

  getBroadcast: (orgId: string, broadcastId: string): Promise<GetBroadcastResponse> =>
    request(`/orgs/${orgId}/broadcasts/${broadcastId}`),

  /** What a campaign would reach and be billed as, before scheduling it. Names no price on purpose. */
  previewBroadcast: (
    orgId: string,
    body: PreviewBroadcastRequest,
  ): Promise<PreviewBroadcastResponse> =>
    request(`/orgs/${orgId}/broadcasts/preview`, { method: 'POST', body }),

  cancelBroadcast: (orgId: string, broadcastId: string): Promise<CancelBroadcastResponse> =>
    request(`/orgs/${orgId}/broadcasts/${broadcastId}/cancel`, { method: 'POST', body: {} }),

  resumeBroadcast: (orgId: string, broadcastId: string): Promise<ResumeBroadcastResponse> =>
    request(`/orgs/${orgId}/broadcasts/${broadcastId}/resume`, { method: 'POST', body: {} }),

  listBroadcastRecipients: (
    orgId: string,
    broadcastId: string,
    params: ListBroadcastRecipientsRequest = {},
  ): Promise<ListBroadcastRecipientsResponse> => {
    const query = new URLSearchParams();
    if (params.status !== undefined) query.set('status', params.status);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.offset !== undefined) query.set('offset', String(params.offset));
    const suffix = query.toString();
    return request(`/orgs/${orgId}/broadcasts/${broadcastId}/recipients${suffix ? `?${suffix}` : ''}`);
  },

  /** The pass-through line on the invoice: what Meta charged, by category, over a period. */
  getCommerceCosts: (orgId: string, params: GetCommerceCostsRequest): Promise<GetCommerceCostsResponse> => {
    const query = new URLSearchParams({ from: params.from, to: params.to });
    return request(`/orgs/${orgId}/costs?${query.toString()}`);
  },

  listCommerceJobs: (
    orgId: string,
    params: ListCommerceJobsRequest = {},
  ): Promise<ListCommerceJobsResponse> => {
    const query = new URLSearchParams();
    if (params.status !== undefined) query.set('status', params.status);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    const suffix = query.toString();
    return request(`/orgs/${orgId}/jobs${suffix ? `?${suffix}` : ''}`);
  },
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
