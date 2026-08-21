import type {
  ArchiveProjectResponse,
  BindProjectWorkspaceRequest,
  BindProjectWorkspaceResponse,
  CreateProjectRequest,
  CreateProjectResponse,
  GetProjectResponse,
  ListOrgProjectBindingsResponse,
  ListProjectWorkspacesResponse,
  ListProjectsResponse,
  Project,
  UnbindProjectWorkspaceResponse,
  UpdateProjectRequest,
  UpdateProjectResponse,
} from '@stewra/shared-types';
import { auditWriter } from '../control-plane/audit/auditWriter.js';
import { projectRepository, projectSlug } from '../repositories/projectRepository.js';
import type { ProjectPatch } from '../repositories/projectRepository.js';
import { runnerService } from './runnerService.js';
import type { OrgActor } from './runnerService.js';
import { organizationRepository } from '../tenancy/repositories/organizationRepository.js';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/**
 * Projects — the thing a person NAMES ("Truetalk") that a repository (`product_advisor`) and a checkout
 * on each machine hang off. The name and the repo name are separate columns because the real projects
 * prove they diverge.
 *
 * TENANCY. Every method takes an `OrgActor` whose `orgId` came from the `:orgId` path segment. The
 * repository scopes each query by it; this service adds the pre-checks that turn a unique-index
 * violation into a sentence (409), and the audit row every mutation owes (invariant 7).
 */
class ProjectService {
  /**
   * The names a person says for their projects — every live project's name and aliases across every
   * org they belong to. Fed to speech-to-text as vocabulary, so "Truetalk" is transcribed as written.
   * Per-org reads under the hood (invariant 1: every project access is scoped by an org), joined here
   * because a voice note has no org yet.
   */
  async vocabularyForUser(userId: string): Promise<string[]> {
    const memberships = await organizationRepository.listForUser(userId);
    const words = new Set<string>();
    for (const m of memberships) {
      for (const project of await projectRepository.list(m.org.id, false)) {
        words.add(project.name);
        for (const alias of project.aliases) words.add(alias);
      }
    }
    return [...words];
  }

  private cleanAliases(aliases: readonly string[] | undefined): string[] {
    if (aliases === undefined) return [];
    const seen = new Set<string>();
    for (const raw of aliases) {
      const alias = raw.trim();
      if (alias.length === 0) continue;
      if (alias.length > 64) {
        throw new ValidationError('Validation failed', [{ field: 'aliases', message: 'An alias is at most 64 characters' }]);
      }
      seen.add(alias);
    }
    return [...seen];
  }

  /** The slug must be non-empty (a name of only punctuation has no handle) and unused in the org. */
  private async assertSlugFree(orgId: string, name: string, exceptProjectId: string | null): Promise<string> {
    const slug = projectSlug(name);
    if (slug.length === 0) {
      throw new ValidationError('Validation failed', [
        { field: 'name', message: 'A project name needs at least one letter or digit' },
      ]);
    }
    const existing = await projectRepository.findBySlug(orgId, slug);
    if (existing !== null && existing.id !== exceptProjectId) {
      throw new ConflictError(`A project named "${existing.name}" already exists in this organization`);
    }
    return slug;
  }

  async create(actor: OrgActor, req: CreateProjectRequest): Promise<CreateProjectResponse> {
    const name = req.name.trim();
    const slug = await this.assertSlugFree(actor.orgId, name, null);
    const project = await projectRepository.create({
      orgId: actor.orgId,
      name,
      slug,
      repoName: req.repoName.trim(),
      gitRemote: req.gitRemote?.trim() ?? null,
      githubOwner: req.githubOwner?.trim() ?? null,
      githubRepo: req.githubRepo?.trim() ?? null,
      defaultBranch: req.defaultBranch?.trim() ?? 'main',
      aliases: this.cleanAliases(req.aliases),
      description: req.description?.trim() ?? '',
      createdBy: actor.userId,
    });
    await auditWriter.write({
      userId: actor.userId,
      // 'connect' / 'disconnect' are the audit vocabulary for attaching and detaching configuration
      // that lets code run somewhere (a runner, a data source). A project is exactly that kind of row.
      action: 'connect',
      resourceType: 'system',
      resourceId: project.id,
      summary: `You created the project "${project.name}" (${project.repoName}).`,
      success: true,
      metadata: { orgId: actor.orgId, projectId: project.id, repoName: project.repoName },
    });
    logger.info('project: created', { orgId: actor.orgId, projectId: project.id, userId: actor.userId });
    return { project };
  }

  async list(orgId: string, includeArchived: boolean): Promise<ListProjectsResponse> {
    const projects = await projectRepository.list(orgId, includeArchived);
    return { projects };
  }

  async get(orgId: string, projectId: string): Promise<GetProjectResponse> {
    const project = await this.require(orgId, projectId);
    const bindings = await projectRepository.listBindingsForProject(orgId, projectId);
    return { project, bindings };
  }

  async update(actor: OrgActor, projectId: string, req: UpdateProjectRequest): Promise<UpdateProjectResponse> {
    await this.require(actor.orgId, projectId);
    const patch: ProjectPatch = {};
    if (req.name !== undefined) {
      const name = req.name.trim();
      patch.slug = await this.assertSlugFree(actor.orgId, name, projectId);
      patch.name = name;
    }
    if (req.repoName !== undefined) patch.repoName = req.repoName.trim();
    if (req.gitRemote !== undefined) patch.gitRemote = req.gitRemote === null ? null : req.gitRemote.trim();
    if (req.githubOwner !== undefined) patch.githubOwner = req.githubOwner === null ? null : req.githubOwner.trim();
    if (req.githubRepo !== undefined) patch.githubRepo = req.githubRepo === null ? null : req.githubRepo.trim();
    if (req.defaultBranch !== undefined) patch.defaultBranch = req.defaultBranch.trim();
    if (req.aliases !== undefined) patch.aliases = this.cleanAliases(req.aliases);
    if (req.description !== undefined) patch.description = req.description.trim();
    if (Object.keys(patch).length === 0) {
      throw new ValidationError('Validation failed', [{ field: 'name', message: 'Nothing to change' }]);
    }
    const project = await projectRepository.update(actor.orgId, projectId, patch);
    if (project === null) throw new NotFoundError('That project does not exist');
    await auditWriter.write({
      userId: actor.userId,
      action: 'connect',
      resourceType: 'system',
      resourceId: project.id,
      summary: `You updated the project "${project.name}".`,
      success: true,
      metadata: { orgId: actor.orgId, projectId: project.id, fields: Object.keys(patch).join(',') },
    });
    return { project };
  }

  /** Archive, never delete: sessions point at projects by RESTRICT foreign key, and history stays true. */
  async archive(actor: OrgActor, projectId: string): Promise<ArchiveProjectResponse> {
    const existing = await this.require(actor.orgId, projectId);
    const project = await projectRepository.archive(actor.orgId, projectId);
    if (project === null) throw new ConflictError(`"${existing.name}" is already archived`);
    await auditWriter.write({
      userId: actor.userId,
      action: 'disconnect',
      resourceType: 'system',
      resourceId: project.id,
      summary: `You archived the project "${project.name}".`,
      success: true,
      metadata: { orgId: actor.orgId, projectId: project.id },
    });
    logger.info('project: archived', { orgId: actor.orgId, projectId, userId: actor.userId });
    return { project };
  }

  // ── Bindings ────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Bind the project to a checkout a machine has REPORTED. The workspace must be in the device's latest
   * hello — the server snapshots what the runner said and never accepts a path it has not seen. Both
   * unique indexes are pre-checked so the answer is a sentence, not a constraint name.
   */
  async bind(actor: OrgActor, projectId: string, req: BindProjectWorkspaceRequest): Promise<BindProjectWorkspaceResponse> {
    const project = await this.require(actor.orgId, projectId);
    if (project.archivedAt !== null) throw new ConflictError(`"${project.name}" is archived`);
    const device = await runnerService.requireDevice(actor.orgId, req.deviceId);
    const workspace = device.workspaces.find((w) => w.id === req.workspaceId);
    if (workspace === undefined) {
      throw new ConflictError(
        `${device.name} has not reported that checkout — check the volume is mounted, then Rescan`,
      );
    }

    const taken = await projectRepository.findBindingForWorkspace(actor.orgId, device.id, workspace.id);
    if (taken !== null) {
      const other = await projectRepository.get(actor.orgId, taken.projectId);
      throw new ConflictError(
        `That checkout on ${device.name} is already bound to "${other?.name ?? taken.projectId}"`,
      );
    }
    const onDevice = (await projectRepository.listBindingsForProject(actor.orgId, projectId)).find(
      (b) => b.deviceId === device.id,
    );
    if (onDevice !== undefined) {
      throw new ConflictError(`"${project.name}" is already bound on ${device.name} (${onDevice.workspacePath})`);
    }

    const binding = await projectRepository.createBinding({
      orgId: actor.orgId,
      projectId,
      deviceId: device.id,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspacePath: workspace.path,
      // NULL means "the runner did not report one" — the binding suggester must not then claim a match.
      gitRemote: workspace.gitRemote ?? null,
      boundBy: actor.userId,
    });
    await auditWriter.write({
      userId: actor.userId,
      action: 'connect',
      resourceType: 'system',
      resourceId: binding.id,
      summary: `You bound "${project.name}" to ${workspace.path} on ${device.name}.`,
      success: true,
      metadata: { orgId: actor.orgId, projectId, deviceId: device.id, workspaceId: workspace.id },
    });
    logger.info('project: bound', { orgId: actor.orgId, projectId, deviceId: device.id, workspaceId: workspace.id });
    return { binding };
  }

  async listBindings(orgId: string, projectId: string): Promise<ListProjectWorkspacesResponse> {
    await this.require(orgId, projectId);
    const bindings = await projectRepository.listBindingsForProject(orgId, projectId);
    return { bindings };
  }

  async listOrgBindings(orgId: string): Promise<ListOrgProjectBindingsResponse> {
    const bindings = await projectRepository.listBindingsForOrg(orgId);
    return { bindings };
  }

  async unbind(actor: OrgActor, projectId: string, bindingId: string): Promise<UnbindProjectWorkspaceResponse> {
    const project = await this.require(actor.orgId, projectId);
    const removed = await projectRepository.deleteBinding(actor.orgId, projectId, bindingId);
    if (!removed) throw new NotFoundError('That binding does not exist');
    await auditWriter.write({
      userId: actor.userId,
      action: 'disconnect',
      resourceType: 'system',
      resourceId: bindingId,
      summary: `You unbound a checkout from "${project.name}".`,
      success: true,
      metadata: { orgId: actor.orgId, projectId, bindingId },
    });
    return { removed };
  }

  private async require(orgId: string, projectId: string): Promise<Project> {
    const project = await projectRepository.get(orgId, projectId);
    if (project === null) throw new NotFoundError('That project does not exist');
    return project;
  }
}

export const projectService = new ProjectService();
