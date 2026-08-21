import type {
  ArchiveProjectResponse,
  BindProjectWorkspaceRequest,
  BindProjectWorkspaceResponse,
  CreateProjectRequest,
  CreateProjectResponse,
  DecideRunnerPermissionRequest,
  GetProjectResponse,
  GetRunnerStatusResponse,
  ListOrgProjectBindingsResponse,
  ListProjectsResponse,
  ListRunnerSessionsResponse,
  MoveRunnerDeviceRequest,
  MoveRunnerDeviceResponse,
  OpenRunnerPrRequest,
  OpenRunnerPrResponse,
  PromptRunnerSessionRequest,
  PushRunnerSessionResponse,
  RevokeRunnerDeviceResponse,
  RunnerSessionActionResponse,
  StartOrgRunnerSessionRequest,
  StartRunnerPairingResponse,
  StartRunnerSessionRequest,
  StartRunnerSessionResponse,
  UnbindProjectWorkspaceResponse,
  UpdateProjectRequest,
  UpdateProjectResponse,
  UpdateRunnerDeviceRequest,
  UpdateRunnerDeviceResponse,
} from '@stewra/shared-types';
import { runnerRequest as request } from './runnerService';

/**
 * The org-scoped fleet surface: projects under `/orgs/:orgId/projects`, machines and sessions under
 * `/orgs/:orgId/runner`. The org is ALWAYS the path segment — nothing here puts a tenant in a body —
 * and the server's `requireOrgMember` is the door: `viewer` reads, `admin` writes.
 */
export const projectService = {
  list: (orgId: string, includeArchived = false): Promise<ListProjectsResponse> =>
    request(`/orgs/${orgId}/projects${includeArchived ? '?archived=1' : ''}`),

  get: (orgId: string, projectId: string): Promise<GetProjectResponse> =>
    request(`/orgs/${orgId}/projects/${projectId}`),

  create: (orgId: string, body: CreateProjectRequest): Promise<CreateProjectResponse> =>
    request(`/orgs/${orgId}/projects`, { method: 'POST', body }),

  update: (orgId: string, projectId: string, body: UpdateProjectRequest): Promise<UpdateProjectResponse> =>
    request(`/orgs/${orgId}/projects/${projectId}`, { method: 'PATCH', body }),

  archive: (orgId: string, projectId: string): Promise<ArchiveProjectResponse> =>
    request(`/orgs/${orgId}/projects/${projectId}/archive`, { method: 'POST', body: {} }),

  /** Every binding in the org at once — what the projects × machines matrix is drawn from. */
  listBindings: (orgId: string): Promise<ListOrgProjectBindingsResponse> =>
    request(`/orgs/${orgId}/projects/bindings`),

  bind: (
    orgId: string,
    projectId: string,
    body: BindProjectWorkspaceRequest,
  ): Promise<BindProjectWorkspaceResponse> =>
    request(`/orgs/${orgId}/projects/${projectId}/workspaces`, { method: 'POST', body }),

  unbind: (orgId: string, projectId: string, bindingId: string): Promise<UnbindProjectWorkspaceResponse> =>
    request(`/orgs/${orgId}/projects/${projectId}/workspaces/${bindingId}`, { method: 'DELETE' }),
};

export const orgRunnerService = {
  getStatus: (orgId: string): Promise<GetRunnerStatusResponse> => request(`/orgs/${orgId}/runner`),

  startPairing: (orgId: string): Promise<StartRunnerPairingResponse> =>
    request(`/orgs/${orgId}/runner/pair`, { method: 'POST', body: {} }),

  updateDevice: (
    orgId: string,
    deviceId: string,
    body: UpdateRunnerDeviceRequest,
  ): Promise<UpdateRunnerDeviceResponse> =>
    request(`/orgs/${orgId}/runner/devices/${deviceId}`, { method: 'PATCH', body }),

  moveDevice: (orgId: string, deviceId: string, body: MoveRunnerDeviceRequest): Promise<MoveRunnerDeviceResponse> =>
    request(`/orgs/${orgId}/runner/devices/${deviceId}/move`, { method: 'POST', body }),

  /** Ask the machine to re-read its workspace roots — after mounting the volume, say. */
  rescanDevice: (orgId: string, deviceId: string): Promise<{ ok: boolean }> =>
    request(`/orgs/${orgId}/runner/devices/${deviceId}/rescan`, { method: 'POST', body: {} }),

  revokeDevice: (orgId: string, deviceId: string): Promise<RevokeRunnerDeviceResponse> =>
    request(`/orgs/${orgId}/runner/devices/${deviceId}`, { method: 'DELETE' }),

  listSessions: (orgId: string): Promise<ListRunnerSessionsResponse> => request(`/orgs/${orgId}/runner/sessions`),

  /**
   * Start by project. When the project is bound on more than one machine and `deviceId` is absent the
   * server answers 409 `CHOICE_REQUIRED` with the candidates in `details` — it never picks.
   */
  startSession: (orgId: string, body: StartOrgRunnerSessionRequest): Promise<StartRunnerSessionResponse> =>
    request(`/orgs/${orgId}/runner/sessions`, { method: 'POST', body }),

  /** Start on a specific checkout, project or not — the matrix cell's "Run here". */
  startWorkspaceSession: (orgId: string, body: StartRunnerSessionRequest): Promise<StartRunnerSessionResponse> =>
    request(`/orgs/${orgId}/runner/sessions`, { method: 'POST', body }),

  promptSession: (orgId: string, id: string, body: PromptRunnerSessionRequest): Promise<RunnerSessionActionResponse> =>
    request(`/orgs/${orgId}/runner/sessions/${id}/prompt`, { method: 'POST', body }),

  decidePermission: (
    orgId: string,
    id: string,
    body: DecideRunnerPermissionRequest,
  ): Promise<RunnerSessionActionResponse> =>
    request(`/orgs/${orgId}/runner/sessions/${id}/permission`, { method: 'POST', body }),

  cancelSession: (orgId: string, id: string): Promise<RunnerSessionActionResponse> =>
    request(`/orgs/${orgId}/runner/sessions/${id}/cancel`, { method: 'POST', body: {} }),

  pushSession: (orgId: string, id: string): Promise<PushRunnerSessionResponse> =>
    request(`/orgs/${orgId}/runner/sessions/${id}/push`, { method: 'POST', body: {} }),

  openPr: (orgId: string, id: string, body: OpenRunnerPrRequest): Promise<OpenRunnerPrResponse> =>
    request(`/orgs/${orgId}/runner/sessions/${id}/pr`, { method: 'POST', body }),
};
