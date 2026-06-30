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
  GetPreferencesResponse,
  UpdatePreferencesRequest,
  UpdatePreferencesResponse,
} from '@stewra/shared-types';

const BASE_URL = import.meta.env.VITE_API_BASE_URL;
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

export const api = {
  register: (body: RegisterRequest): Promise<RegisterResponse> =>
    request('/auth/register', { method: 'POST', body, auth: false }),

  login: (body: LoginRequest): Promise<LoginResponse> =>
    request('/auth/login', { method: 'POST', body, auth: false }),

  me: (): Promise<GetAuthStatusResponse> => request('/auth/me'),

  listActivity: (): Promise<ListActivityResponse> => request('/activity'),

  listConnections: (): Promise<ListConnectionsResponse> => request('/connections'),

  startGoogleConnection: (): Promise<StartCalendarConnectionResponse> =>
    request('/connections/google/start', { method: 'POST', body: {} }),

  disconnect: (id: string): Promise<ConnectionResponse> =>
    request(`/connections/${id}/disconnect`, { method: 'POST', body: {} }),

  generateInsight: (body: GenerateInsightRequest): Promise<GenerateInsightResponse> =>
    request('/insights', { method: 'POST', body }),

  getPreferences: (): Promise<GetPreferencesResponse> => request('/preferences'),

  updatePreferences: (body: UpdatePreferencesRequest): Promise<UpdatePreferencesResponse> =>
    request('/preferences', { method: 'PATCH', body }),
};
