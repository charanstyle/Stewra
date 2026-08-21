import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { machineAccessService } from '../services/machineAccessService.js';
import type { OrgActor } from '../services/runnerService.js';
import { orgContext } from '../tenancy/middleware/requireOrgMember.js';
import { parse } from '../utils/validate.js';

const requestIdSchema = z.object({ requestId: z.string().uuid() });

/** Approve or refuse — one boolean, because a refusal is a decision and must be recorded as one. */
const decideSchema = z.object({ approve: z.boolean() });

function actorOf(req: Request): OrgActor {
  const userId = req.userId;
  if (userId === undefined) throw new Error('requireAuth middleware missing');
  return { orgId: orgContext(req).orgId, userId };
}

/** `/orgs/:orgId/machine-access`. Errors go to `next` so `errorHandler` serializes `details`. */
class MachineAccessController {
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.json({ success: true, data: await machineAccessService.list(actorOf(req)) });
    } catch (error) {
      next(error);
    }
  }

  async decide(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { requestId } = parse(requestIdSchema, req.params);
      const body = parse(decideSchema, req.body);
      res.json({ success: true, data: await machineAccessService.decide(actorOf(req), requestId, body) });
    } catch (error) {
      next(error);
    }
  }
}

export const machineAccessController = new MachineAccessController();
