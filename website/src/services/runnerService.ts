import type {
  ApiResponse,
  DecideRunnerPermissionRequest,
  GetRunnerStatusResponse,
  ListRunnerDevicesResponse,
  ListRunnerSessionsResponse,
  PromptRunnerSessionRequest,
  RevokeRunnerDeviceResponse,
  RunnerSessionActionResponse,
  StartRunnerPairingResponse,
  StartRunnerSessionRequest,
  StartRunnerSessionResponse,
} from '@stewra/shared-types';
import { BASE_URL, readTokens, ApiError } from './api';

/**
 * Service calls for the Stewra Runner — the process a user installs on their OWN machine to host coding
 * agents. Mirrors the whatsapp-personal bridge calls in `api.ts`, and reuses that module's configured
 * `BASE_URL` / bearer-token / `ApiError` plumbing rather than hardcoding any of it.
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
    throw new ApiError(payload.error.message, payload.error.code);
  }
  return payload.data;
}

export const runnerService = {
  getStatus: (): Promise<GetRunnerStatusResponse> => request('/runner'),

  listDevices: (): Promise<ListRunnerDevicesResponse> => request('/runner/devices'),

  startPairing: (): Promise<StartRunnerPairingResponse> =>
    request('/runner/pair', { method: 'POST', body: {} }),

  revokeDevice: (id: string): Promise<RevokeRunnerDeviceResponse> =>
    request(`/runner/devices/${id}`, { method: 'DELETE' }),

  listSessions: (): Promise<ListRunnerSessionsResponse> => request('/runner/sessions'),

  startSession: (body: StartRunnerSessionRequest): Promise<StartRunnerSessionResponse> =>
    request('/runner/sessions', { method: 'POST', body }),

  promptSession: (id: string, body: PromptRunnerSessionRequest): Promise<RunnerSessionActionResponse> =>
    request(`/runner/sessions/${id}/prompt`, { method: 'POST', body }),

  decidePermission: (
    id: string,
    body: DecideRunnerPermissionRequest,
  ): Promise<RunnerSessionActionResponse> =>
    request(`/runner/sessions/${id}/permission`, { method: 'POST', body }),

  cancelSession: (id: string): Promise<RunnerSessionActionResponse> =>
    request(`/runner/sessions/${id}/cancel`, { method: 'POST', body: {} }),
};
