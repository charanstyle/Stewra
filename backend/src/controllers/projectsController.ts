import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import type { CreateProjectRequest, UpdateProjectRequest } from '@stewra/shared-types';
import { projectService } from '../services/projectService.js';
import type { OrgActor } from '../services/runnerService.js';
import { orgContext } from '../tenancy/middleware/requireOrgMember.js';
import { parse } from '../utils/validate.js';

const projectIdSchema = z.object({ projectId: z.string().uuid() });
const bindingIdSchema = z.object({ projectId: z.string().uuid(), bindingId: z.string().uuid() });

/** Names and slugs are echoed into audit rows, session rows and the STT prompt — bounded, not free. */
const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  repoName: z.string().trim().min(1).max(120),
  gitRemote: z.string().trim().min(1).max(512).optional(),
  githubOwner: z.string().trim().min(1).max(80).optional(),
  githubRepo: z.string().trim().min(1).max(120).optional(),
  defaultBranch: z.string().trim().min(1).max(120).optional(),
  aliases: z.array(z.string().max(64)).max(20).optional(),
  description: z.string().max(2_000).optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  repoName: z.string().trim().min(1).max(120).optional(),
  gitRemote: z.string().trim().min(1).max(512).nullable().optional(),
  githubOwner: z.string().trim().min(1).max(80).nullable().optional(),
  githubRepo: z.string().trim().min(1).max(120).nullable().optional(),
  defaultBranch: z.string().trim().min(1).max(120).optional(),
  aliases: z.array(z.string().max(64)).max(20).optional(),
  description: z.string().max(2_000).optional(),
});

const bindSchema = z.object({
  deviceId: z.string().uuid(),
  workspaceId: z.string().min(1).max(128),
});

function actorOf(req: Request): OrgActor {
  const userId = req.userId;
  if (userId === undefined) throw new Error('requireAuth middleware missing');
  return { orgId: orgContext(req).orgId, userId };
}

/** `/orgs/:orgId/projects`. Errors go to `next` so `errorHandler` serializes `details`. */
class ProjectsController {
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const archived = req.query['archived'];
      const includeArchived = archived === '1' || archived === 'true';
      res.json({ success: true, data: await projectService.list(actorOf(req).orgId, includeArchived) });
    } catch (error) {
      next(error);
    }
  }

  async listOrgBindings(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.json({ success: true, data: await projectService.listOrgBindings(actorOf(req).orgId) });
    } catch (error) {
      next(error);
    }
  }

  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const b = parse(createSchema, req.body);
      // Rebuilt so absent optionals stay absent under exactOptionalPropertyTypes.
      const body: CreateProjectRequest = {
        name: b.name,
        repoName: b.repoName,
        ...(b.gitRemote !== undefined ? { gitRemote: b.gitRemote } : {}),
        ...(b.githubOwner !== undefined ? { githubOwner: b.githubOwner } : {}),
        ...(b.githubRepo !== undefined ? { githubRepo: b.githubRepo } : {}),
        ...(b.defaultBranch !== undefined ? { defaultBranch: b.defaultBranch } : {}),
        ...(b.aliases !== undefined ? { aliases: b.aliases } : {}),
        ...(b.description !== undefined ? { description: b.description } : {}),
      };
      res.status(201).json({ success: true, data: await projectService.create(actorOf(req), body) });
    } catch (error) {
      next(error);
    }
  }

  async get(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { projectId } = parse(projectIdSchema, req.params);
      res.json({ success: true, data: await projectService.get(actorOf(req).orgId, projectId) });
    } catch (error) {
      next(error);
    }
  }

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { projectId } = parse(projectIdSchema, req.params);
      const b = parse(updateSchema, req.body);
      const body: UpdateProjectRequest = {
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.repoName !== undefined ? { repoName: b.repoName } : {}),
        ...(b.gitRemote !== undefined ? { gitRemote: b.gitRemote } : {}),
        ...(b.githubOwner !== undefined ? { githubOwner: b.githubOwner } : {}),
        ...(b.githubRepo !== undefined ? { githubRepo: b.githubRepo } : {}),
        ...(b.defaultBranch !== undefined ? { defaultBranch: b.defaultBranch } : {}),
        ...(b.aliases !== undefined ? { aliases: b.aliases } : {}),
        ...(b.description !== undefined ? { description: b.description } : {}),
      };
      res.json({ success: true, data: await projectService.update(actorOf(req), projectId, body) });
    } catch (error) {
      next(error);
    }
  }

  async archive(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { projectId } = parse(projectIdSchema, req.params);
      res.json({ success: true, data: await projectService.archive(actorOf(req), projectId) });
    } catch (error) {
      next(error);
    }
  }

  async listBindings(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { projectId } = parse(projectIdSchema, req.params);
      res.json({ success: true, data: await projectService.listBindings(actorOf(req).orgId, projectId) });
    } catch (error) {
      next(error);
    }
  }

  async bind(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { projectId } = parse(projectIdSchema, req.params);
      const body = parse(bindSchema, req.body);
      res.status(201).json({ success: true, data: await projectService.bind(actorOf(req), projectId, body) });
    } catch (error) {
      next(error);
    }
  }

  async unbind(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { projectId, bindingId } = parse(bindingIdSchema, req.params);
      res.json({ success: true, data: await projectService.unbind(actorOf(req), projectId, bindingId) });
    } catch (error) {
      next(error);
    }
  }
}

export const projectsController = new ProjectsController();
