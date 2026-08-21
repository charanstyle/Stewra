import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { RUNNER_ENVIRONMENTS, RUNNER_HARNESS_IDS } from '@stewra/shared-types';
import {
  openPrBodySchema,
  permissionBodySchema,
  promptBodySchema,
  startSessionSchema,
} from './runnerController.js';
import { runnerService } from '../services/runnerService.js';
import type { OrgActor } from '../services/runnerService.js';
import { runnerSessionService } from '../services/runnerSessionService.js';
import { orgContext } from '../tenancy/middleware/requireOrgMember.js';
import { rescanRunner } from '../websocket/runnerEmitter.js';
import { parse } from '../utils/validate.js';

const deviceIdSchema = z.object({ id: z.string().uuid() });
const sessionIdSchema = z.object({ id: z.string().uuid() });

const updateDeviceSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  environment: z.enum(RUNNER_ENVIRONMENTS).optional(),
});

const moveDeviceSchema = z.object({ toOrgId: z.string().uuid() });

const startOrgSessionSchema = z.object({
  projectId: z.string().uuid(),
  deviceId: z.string().uuid().optional(),
  harness: z.enum(RUNNER_HARNESS_IDS),
  prompt: z.string().min(1).max(100_000),
});

/**
 * Who is acting, from the two middlewares that already ran: `requireAuth` put the user on the request,
 * `requireOrgMember` put the org from the `:orgId` path segment. Nothing here reads a body for a tenant.
 */
function actorOf(req: Request): OrgActor {
  const userId = req.userId;
  if (userId === undefined) throw new Error('requireAuth middleware missing');
  return { orgId: orgContext(req).orgId, userId };
}

/**
 * The org-scoped runner surface, `/orgs/:orgId/runner`. Errors go to `next` so `errorHandler` serializes
 * `details` — the candidate list on a `CHOICE_REQUIRED` 409 is how the fleet page asks "which machine?".
 */
class OrgRunnerController {
  /** GET /orgs/:orgId/runner */
  async status(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.json({ success: true, data: await runnerService.getStatus(actorOf(req).orgId) });
    } catch (error) {
      next(error);
    }
  }

  /** GET /orgs/:orgId/runner/devices */
  async listDevices(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.json({ success: true, data: await runnerService.listDevices(actorOf(req).orgId) });
    } catch (error) {
      next(error);
    }
  }

  /** POST /orgs/:orgId/runner/pair */
  async startPairing(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.status(201).json({ success: true, data: await runnerService.startPairing(actorOf(req)) });
    } catch (error) {
      next(error);
    }
  }

  /** PATCH /orgs/:orgId/runner/devices/:id */
  async updateDevice(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = parse(deviceIdSchema, req.params);
      const body = parse(updateDeviceSchema, req.body);
      // Rebuilt so absent optionals stay absent under exactOptionalPropertyTypes.
      const device = await runnerService.updateDevice(actorOf(req), id, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.environment !== undefined ? { environment: body.environment } : {}),
      });
      res.json({ success: true, data: { device } });
    } catch (error) {
      next(error);
    }
  }

  /** POST /orgs/:orgId/runner/devices/:id/move */
  async moveDevice(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = parse(deviceIdSchema, req.params);
      const { toOrgId } = parse(moveDeviceSchema, req.body);
      const device = await runnerService.moveDevice(actorOf(req), id, toOrgId);
      res.json({ success: true, data: { device } });
    } catch (error) {
      next(error);
    }
  }

  /** POST /orgs/:orgId/runner/devices/:id/rescan — ask the machine to re-read its workspace roots. */
  async rescanDevice(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = parse(deviceIdSchema, req.params);
      const device = await runnerService.requireDevice(actorOf(req).orgId, id);
      const ok = await rescanRunner(device.id);
      res.json({ success: true, data: { ok } });
    } catch (error) {
      next(error);
    }
  }

  /** DELETE /orgs/:orgId/runner/devices/:id */
  async revokeDevice(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = parse(deviceIdSchema, req.params);
      const revoked = await runnerService.revokeDevice(actorOf(req), id);
      res.json({ success: true, data: { revoked } });
    } catch (error) {
      next(error);
    }
  }

  /** GET /orgs/:orgId/runner/sessions */
  async listSessions(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.json({ success: true, data: await runnerSessionService.listSessions(actorOf(req).orgId) });
    } catch (error) {
      next(error);
    }
  }

  /** GET /orgs/:orgId/runner/sessions/:id */
  async getSession(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = parse(sessionIdSchema, req.params);
      const session = await runnerSessionService.getSession(actorOf(req).orgId, id);
      res.json({ success: true, data: { session } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /orgs/:orgId/runner/sessions — by project (`projectId`, optional `deviceId`) or, for the
   * fleet page's "Run here" on a specific checkout, by device + workspace. The body says which.
   */
  async startSession(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const actor = actorOf(req);
      const byProject = startOrgSessionSchema.safeParse(req.body);
      const session = byProject.success
        ? await runnerSessionService.startOrgSession(actor, {
            projectId: byProject.data.projectId,
            harness: byProject.data.harness,
            prompt: byProject.data.prompt,
            ...(byProject.data.deviceId !== undefined ? { deviceId: byProject.data.deviceId } : {}),
          })
        : await runnerSessionService.startSession(actor, parse(startSessionSchema, req.body));
      res.status(201).json({ success: true, data: { session } });
    } catch (error) {
      next(error);
    }
  }

  /** POST /orgs/:orgId/runner/sessions/:id/prompt */
  async promptSession(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = parse(sessionIdSchema, req.params);
      const { text } = parse(promptBodySchema, req.body);
      res.json({ success: true, data: await runnerSessionService.prompt(actorOf(req).orgId, id, text) });
    } catch (error) {
      next(error);
    }
  }

  /** POST /orgs/:orgId/runner/sessions/:id/permission */
  async decidePermission(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = parse(sessionIdSchema, req.params);
      const { promptId, optionId } = parse(permissionBodySchema, req.body);
      res.json({
        success: true,
        data: await runnerSessionService.decidePermission(actorOf(req).orgId, id, promptId, optionId),
      });
    } catch (error) {
      next(error);
    }
  }

  /** POST /orgs/:orgId/runner/sessions/:id/cancel */
  async cancelSession(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = parse(sessionIdSchema, req.params);
      res.json({ success: true, data: await runnerSessionService.cancel(actorOf(req).orgId, id) });
    } catch (error) {
      next(error);
    }
  }

  /** POST /orgs/:orgId/runner/sessions/:id/push */
  async pushSession(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = parse(sessionIdSchema, req.params);
      res.json({ success: true, data: await runnerSessionService.pushSession(actorOf(req).orgId, id) });
    } catch (error) {
      next(error);
    }
  }

  /** POST /orgs/:orgId/runner/sessions/:id/pr */
  async openPr(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = parse(sessionIdSchema, req.params);
      const { title, body } = parse(openPrBodySchema, req.body);
      res
        .status(201)
        .json({ success: true, data: await runnerSessionService.openPr(actorOf(req).orgId, id, title, body) });
    } catch (error) {
      next(error);
    }
  }
}

export const orgRunnerController = new OrgRunnerController();
