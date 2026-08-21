import type { Project, ProjectWorkspaceBinding } from '@stewra/shared-types';
import type { Selectable } from 'kysely';
import { db } from '../database/index.js';
import type { ProjectWorkspacesTable, ProjectsTable } from '../database/types.js';

function toProject(row: Selectable<ProjectsTable>): Project {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    slug: row.slug,
    repoName: row.repo_name,
    gitRemote: row.git_remote,
    githubOwner: row.github_owner,
    githubRepo: row.github_repo,
    defaultBranch: row.default_branch,
    aliases: row.aliases,
    description: row.description,
    createdBy: row.created_by,
    archivedAt: row.archived_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toBinding(row: Selectable<ProjectWorkspacesTable>): ProjectWorkspaceBinding {
  return {
    id: row.id,
    projectId: row.project_id,
    orgId: row.org_id,
    deviceId: row.device_id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    workspacePath: row.workspace_path,
    gitRemote: row.git_remote,
    boundBy: row.bound_by,
    lastVerifiedAt: row.last_verified_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * The name the user says, as a handle: lower-case, alphanumeric runs joined by `-`. `uq_projects_org_slug`
 * is what makes "Truetalk" and "truetalk" the same project within an org.
 */
export function projectSlug(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export interface ProjectPatch {
  name?: string;
  slug?: string;
  repoName?: string;
  gitRemote?: string | null;
  githubOwner?: string | null;
  githubRepo?: string | null;
  defaultBranch?: string;
  aliases?: readonly string[];
  description?: string;
}

/**
 * Projects and their workspace bindings (migration 065).
 *
 * TENANCY. Every method takes a required, non-nullable `orgId` and puts it in the WHERE clause. A project
 * id from another tenant therefore resolves to nothing, never to a row. Bindings additionally carry
 * `org_id` so the database's composite foreign keys — not this code — are what refuse a binding between
 * a project and a device that disagree on their tenant.
 */
class ProjectRepository {
  async create(params: {
    orgId: string;
    name: string;
    slug: string;
    repoName: string;
    gitRemote: string | null;
    githubOwner: string | null;
    githubRepo: string | null;
    defaultBranch: string;
    aliases: readonly string[];
    description: string;
    createdBy: string;
  }): Promise<Project> {
    const row = await db
      .insertInto('projects')
      .values({
        org_id: params.orgId,
        name: params.name,
        slug: params.slug,
        repo_name: params.repoName,
        git_remote: params.gitRemote,
        github_owner: params.githubOwner,
        github_repo: params.githubRepo,
        default_branch: params.defaultBranch,
        aliases: JSON.stringify(params.aliases),
        description: params.description,
        created_by: params.createdBy,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toProject(row);
  }

  /** The org's projects, live ones first then by name; archived ones only when asked for. */
  async list(orgId: string, includeArchived: boolean): Promise<Project[]> {
    let query = db.selectFrom('projects').selectAll().where('org_id', '=', orgId);
    if (!includeArchived) query = query.where('archived_at', 'is', null);
    const rows = await query.orderBy('archived_at', 'asc').orderBy('name', 'asc').execute();
    return rows.map(toProject);
  }

  async get(orgId: string, projectId: string): Promise<Project | null> {
    const row = await db
      .selectFrom('projects')
      .selectAll()
      .where('id', '=', projectId)
      .where('org_id', '=', orgId)
      .executeTakeFirst();
    return row === undefined ? null : toProject(row);
  }

  /** A project by its slug, so the service can pre-check the unique index and answer with a sentence. */
  async findBySlug(orgId: string, slug: string): Promise<Project | null> {
    const row = await db
      .selectFrom('projects')
      .selectAll()
      .where('org_id', '=', orgId)
      .where('slug', '=', slug)
      .executeTakeFirst();
    return row === undefined ? null : toProject(row);
  }

  async update(orgId: string, projectId: string, patch: ProjectPatch): Promise<Project | null> {
    const row = await db
      .updateTable('projects')
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.slug !== undefined ? { slug: patch.slug } : {}),
        ...(patch.repoName !== undefined ? { repo_name: patch.repoName } : {}),
        ...(patch.gitRemote !== undefined ? { git_remote: patch.gitRemote } : {}),
        ...(patch.githubOwner !== undefined ? { github_owner: patch.githubOwner } : {}),
        ...(patch.githubRepo !== undefined ? { github_repo: patch.githubRepo } : {}),
        ...(patch.defaultBranch !== undefined ? { default_branch: patch.defaultBranch } : {}),
        ...(patch.aliases !== undefined ? { aliases: JSON.stringify(patch.aliases) } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        updated_at: new Date(),
      })
      .where('id', '=', projectId)
      .where('org_id', '=', orgId)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? null : toProject(row);
  }

  /** Archive. The WHERE on `archived_at IS NULL` makes a second archive a no-op the service reports as 409. */
  async archive(orgId: string, projectId: string): Promise<Project | null> {
    const now = new Date();
    const row = await db
      .updateTable('projects')
      .set({ archived_at: now, updated_at: now })
      .where('id', '=', projectId)
      .where('org_id', '=', orgId)
      .where('archived_at', 'is', null)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? null : toProject(row);
  }

  // ── Bindings ────────────────────────────────────────────────────────────────────────────────────────

  async createBinding(params: {
    orgId: string;
    projectId: string;
    deviceId: string;
    workspaceId: string;
    workspaceName: string;
    workspacePath: string;
    gitRemote: string | null;
    boundBy: string;
  }): Promise<ProjectWorkspaceBinding> {
    const row = await db
      .insertInto('project_workspaces')
      .values({
        org_id: params.orgId,
        project_id: params.projectId,
        device_id: params.deviceId,
        workspace_id: params.workspaceId,
        workspace_name: params.workspaceName,
        workspace_path: params.workspacePath,
        git_remote: params.gitRemote,
        bound_by: params.boundBy,
        last_verified_at: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toBinding(row);
  }

  async listBindingsForProject(orgId: string, projectId: string): Promise<ProjectWorkspaceBinding[]> {
    const rows = await db
      .selectFrom('project_workspaces')
      .selectAll()
      .where('org_id', '=', orgId)
      .where('project_id', '=', projectId)
      .orderBy('created_at', 'asc')
      .execute();
    return rows.map(toBinding);
  }

  /** Every binding in the org — the fleet matrix in one query. */
  async listBindingsForOrg(orgId: string): Promise<ProjectWorkspaceBinding[]> {
    const rows = await db
      .selectFrom('project_workspaces')
      .selectAll()
      .where('org_id', '=', orgId)
      .orderBy('created_at', 'asc')
      .execute();
    return rows.map(toBinding);
  }

  /** The binding for one checkout on one machine, if any — what a legacy device+workspace start resolves to a project through. */
  async findBindingForWorkspace(
    orgId: string,
    deviceId: string,
    workspaceId: string,
  ): Promise<ProjectWorkspaceBinding | null> {
    const row = await db
      .selectFrom('project_workspaces')
      .selectAll()
      .where('org_id', '=', orgId)
      .where('device_id', '=', deviceId)
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirst();
    return row === undefined ? null : toBinding(row);
  }

  async deleteBinding(orgId: string, projectId: string, bindingId: string): Promise<boolean> {
    const result = await db
      .deleteFrom('project_workspaces')
      .where('id', '=', bindingId)
      .where('org_id', '=', orgId)
      .where('project_id', '=', projectId)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  /** The runner reported these workspaces just now: stamp every binding on the device that is among them. */
  async markVerified(deviceId: string, workspaceIds: readonly string[]): Promise<void> {
    if (workspaceIds.length === 0) return;
    await db
      .updateTable('project_workspaces')
      .set({ last_verified_at: new Date() })
      .where('device_id', '=', deviceId)
      .where('workspace_id', 'in', [...workspaceIds])
      .execute();
  }
}

export const projectRepository = new ProjectRepository();
