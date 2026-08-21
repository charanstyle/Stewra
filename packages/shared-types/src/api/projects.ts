// @skip-validation — this file IS the shared-types package. The api-contract guard requires a literal
// `@stewra/shared-types` import in any file declaring *Request/*Response types, which is unsatisfiable
// here (it would be a self-import); every sibling in this directory imports relatively for the same
// reason. Remove this marker if the guard ever learns to exclude packages/shared-types/.
import type { Project, ProjectWorkspaceBinding } from '../models/project';

/**
 * Projects and their workspace bindings — `/orgs/:orgId/projects`. Every route sits behind
 * `requireOrgMember`: `viewer` reads, `admin` writes. The org is ALWAYS the `:orgId` path segment;
 * no body here names a tenant.
 */

/** POST /orgs/:orgId/projects — the user types the name and states the GitHub parameters. */
export interface CreateProjectRequest {
  readonly name: string;
  readonly repoName: string;
  readonly gitRemote?: string;
  readonly githubOwner?: string;
  readonly githubRepo?: string;
  readonly defaultBranch?: string;
  readonly aliases?: readonly string[];
  readonly description?: string;
}

export interface CreateProjectResponse {
  readonly project: Project;
}

/** PATCH /orgs/:orgId/projects/:projectId — any subset. `null` clears a nullable field. */
export interface UpdateProjectRequest {
  readonly name?: string;
  readonly repoName?: string;
  readonly gitRemote?: string | null;
  readonly githubOwner?: string | null;
  readonly githubRepo?: string | null;
  readonly defaultBranch?: string;
  readonly aliases?: readonly string[];
  readonly description?: string;
}

export interface UpdateProjectResponse {
  readonly project: Project;
}

/** GET /orgs/:orgId/projects — live projects first; archived ones only when `?archived=1`. */
export interface ListProjectsResponse {
  readonly projects: readonly Project[];
}

/** GET /orgs/:orgId/projects/:projectId — the project and everywhere it is bound. */
export interface GetProjectResponse {
  readonly project: Project;
  readonly bindings: readonly ProjectWorkspaceBinding[];
}

/**
 * POST /orgs/:orgId/projects/:projectId/archive — projects are archived, never deleted. A session
 * row points at its project by foreign key (RESTRICT), so deletion would fail anyway; archiving is
 * the honest operation, and an archived project refuses new sessions.
 */
export interface ArchiveProjectResponse {
  readonly project: Project;
}

/**
 * POST /orgs/:orgId/projects/:projectId/workspaces — bind the project to a workspace one of the org's
 * machines has reported. The `workspaceId` must appear in that device's latest hello; the server
 * snapshots the name/path/remote it reported. Binding to a workspace nobody has reported is refused,
 * not guessed at.
 */
export interface BindProjectWorkspaceRequest {
  readonly deviceId: string;
  readonly workspaceId: string;
}

export interface BindProjectWorkspaceResponse {
  readonly binding: ProjectWorkspaceBinding;
}

/** GET /orgs/:orgId/projects/:projectId/workspaces */
export interface ListProjectWorkspacesResponse {
  readonly bindings: readonly ProjectWorkspaceBinding[];
}

/** DELETE /orgs/:orgId/projects/:projectId/workspaces/:bindingId */
export interface UnbindProjectWorkspaceResponse {
  readonly removed: boolean;
}

/**
 * GET /orgs/:orgId/projects/bindings — every binding in the org in one call, for the fleet matrix
 * (projects × machines) without N round trips.
 */
export interface ListOrgProjectBindingsResponse {
  readonly bindings: readonly ProjectWorkspaceBinding[];
}
