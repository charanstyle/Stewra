import type {
  ApiResponse,
  GetGithubAppStatusResponse,
  LinkGithubInstallationRequest,
  LinkGithubInstallationResponse,
  UnlinkGithubInstallationResponse,
} from '@stewra/shared-types';
import { BASE_URL, readTokens, ApiError } from './api';

/**
 * Service calls for the Stewra GitHub App — the click-through grant that gives the hosted runner access
 * to chosen repositories without the user ever pasting a credential. Mirrors `runnerService.ts`, and
 * reuses `api.ts`'s configured `BASE_URL` / bearer-token / `ApiError` plumbing rather than hardcoding
 * any of it.
 */
async function request<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const tokens = readTokens();
  if (tokens) {
    headers.Authorization = `Bearer ${tokens.accessToken}`;
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

export const githubAppService = {
  getStatus: (): Promise<GetGithubAppStatusResponse> => request('/github-app'),

  linkInstallation: (body: LinkGithubInstallationRequest): Promise<LinkGithubInstallationResponse> =>
    request('/github-app/installations', { method: 'POST', body }),

  unlink: (): Promise<UnlinkGithubInstallationResponse> =>
    request('/github-app/installations', { method: 'DELETE' }),
};
