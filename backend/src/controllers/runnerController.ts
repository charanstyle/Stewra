import type { Request, Response } from 'express';
import { z } from 'zod';
import { RUNNER_HARNESS_IDS } from '@stewra/shared-types';
import { BaseController } from './baseController.js';
import { runnerService } from '../services/runnerService.js';
import type { OrgActor } from '../services/runnerService.js';
import { runnerSessionService } from '../services/runnerSessionService.js';
import { organizationService } from '../tenancy/services/organizationService.js';
import { parse } from '../utils/validate.js';

/**
 * `deviceName`/`os` are bounded rather than free — they are echoed into the device list and an audit row,
 * and an endpoint that stores whatever text you POST is a storage-abuse vector, not just untidy.
 */
const claimSchema = z.object({
  code: z.string().min(1).max(32),
  deviceName: z.string().min(1).max(64),
  appVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  os: z.string().min(1).max(32),
});

const deviceIdSchema = z.object({
  id: z.string().uuid(),
});

const sessionIdSchema = z.object({ id: z.string().uuid() });

export const startSessionSchema = z.object({
  deviceId: z.string().uuid(),
  harness: z.enum(RUNNER_HARNESS_IDS),
  workspaceId: z.string().min(1).max(128),
  prompt: z.string().min(1).max(100_000),
});

export const promptBodySchema = z.object({ text: z.string().min(1).max(100_000) });

export const permissionBodySchema = z.object({
  promptId: z.string().min(1).max(128),
  optionId: z.string().min(1).max(256),
});

/** PR title/body are echoed onto GitHub, so they're bounded — a create-a-PR endpoint isn't a text dump. */
export const openPrBodySchema = z.object({
  title: z.string().min(1).max(256),
  body: z.string().max(16_000),
});

/**
 * The legacy Stewra Runner surface (`/runner`) — kept so the mobile app, the chat relay and the smoke
 * drivers keep working. There is no `:orgId` in these paths, so each request resolves the org the caller
 * is ACTING in (`organizationService.resolveActingOrg`: their only org, or the active one; with several
 * and none active, a 409 `CHOICE_REQUIRED` — never the first membership). Underneath, every call goes
 * to the same org-scoped services as `/orgs/:orgId/runner`: one code path, two entry points.
 *
 * Everything here runs behind `requireAuth` EXCEPT `claimToken`, which is called by the runner process
 * and authenticates with a single-use pairing code instead — handing a code-executing process the user's
 * access token would give it the whole account when all it needs is permission to run sessions.
 */
class RunnerController extends BaseController {
  private userId(req: Request): string {
    const userId = req.userId;
    if (userId === undefined) throw new Error('requireAuth middleware missing');
    return userId;
  }

  private async actor(req: Request): Promise<OrgActor> {
    const userId = this.userId(req);
    const { orgId } = await organizationService.resolveActingOrg(userId);
    return { orgId, userId };
  }

  /** GET /runner — feature availability + the acting org's runners, for the "Runners" panel. */
  async status(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = await this.actor(req);
      this.handleSuccess(res, await runnerService.getStatus(orgId));
    } catch (error) {
      this.handleError(error, res, 'RunnerController.status');
    }
  }

  /** GET /runner/devices — the acting org's runners with live online state. */
  async listDevices(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = await this.actor(req);
      this.handleSuccess(res, await runnerService.listDevices(orgId));
    } catch (error) {
      this.handleError(error, res, 'RunnerController.listDevices');
    }
  }

  /** POST /runner/pair — mint the single-use code the user pastes into `stewra-runner pair <code>`. */
  async startPairing(req: Request, res: Response): Promise<void> {
    try {
      const result = await runnerService.startPairing(await this.actor(req));
      this.handleSuccess(res, result, 201);
    } catch (error) {
      this.handleError(error, res, 'RunnerController.startPairing');
    }
  }

  /**
   * POST /runner/runner-token — called by the RUNNER process, not the web client. Unauthenticated by
   * design; the pairing code is the credential, and it is burned on use.
   */
  async claimToken(req: Request, res: Response): Promise<void> {
    try {
      const body = parse(claimSchema, req.body);
      const result = await runnerService.claimToken(body);
      this.handleSuccess(res, result, 201);
    } catch (error) {
      this.handleError(error, res, 'RunnerController.claimToken');
    }
  }

  /** DELETE /runner/devices/:id — kill a runner's token immediately. */
  async revokeDevice(req: Request, res: Response): Promise<void> {
    try {
      const { id } = parse(deviceIdSchema, req.params);
      const revoked = await runnerService.revokeDevice(await this.actor(req), id);
      this.handleSuccess(res, { revoked });
    } catch (error) {
      this.handleError(error, res, 'RunnerController.revokeDevice');
    }
  }

  /** GET /runner/sessions — the acting org's runner sessions, newest first. */
  async listSessions(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = await this.actor(req);
      this.handleSuccess(res, await runnerSessionService.listSessions(orgId));
    } catch (error) {
      this.handleError(error, res, 'RunnerController.listSessions');
    }
  }

  /** POST /runner/sessions — start a coding session on a chosen device. */
  async startSession(req: Request, res: Response): Promise<void> {
    try {
      const body = parse(startSessionSchema, req.body);
      const session = await runnerSessionService.startSession(await this.actor(req), body);
      this.handleSuccess(res, { session }, 201);
    } catch (error) {
      this.handleError(error, res, 'RunnerController.startSession');
    }
  }

  /** POST /runner/sessions/:id/prompt — a follow-up turn in a running session. */
  async promptSession(req: Request, res: Response): Promise<void> {
    try {
      const { id } = parse(sessionIdSchema, req.params);
      const { text } = parse(promptBodySchema, req.body);
      const { orgId } = await this.actor(req);
      this.handleSuccess(res, await runnerSessionService.prompt(orgId, id, text));
    } catch (error) {
      this.handleError(error, res, 'RunnerController.promptSession');
    }
  }

  /** POST /runner/sessions/:id/permission — relay the user's permission answer to the runner. */
  async decidePermission(req: Request, res: Response): Promise<void> {
    try {
      const { id } = parse(sessionIdSchema, req.params);
      const { promptId, optionId } = parse(permissionBodySchema, req.body);
      const { orgId } = await this.actor(req);
      this.handleSuccess(res, await runnerSessionService.decidePermission(orgId, id, promptId, optionId));
    } catch (error) {
      this.handleError(error, res, 'RunnerController.decidePermission');
    }
  }

  /** POST /runner/sessions/:id/cancel — stop a running session. */
  async cancelSession(req: Request, res: Response): Promise<void> {
    try {
      const { id } = parse(sessionIdSchema, req.params);
      const { orgId } = await this.actor(req);
      this.handleSuccess(res, await runnerSessionService.cancel(orgId, id));
    } catch (error) {
      this.handleError(error, res, 'RunnerController.cancelSession');
    }
  }

  /** POST /runner/sessions/:id/push — push a finished session's branch to its remote. */
  async pushSession(req: Request, res: Response): Promise<void> {
    try {
      const { id } = parse(sessionIdSchema, req.params);
      const { orgId } = await this.actor(req);
      this.handleSuccess(res, await runnerSessionService.pushSession(orgId, id));
    } catch (error) {
      this.handleError(error, res, 'RunnerController.pushSession');
    }
  }

  /** POST /runner/sessions/:id/pr — open a pull request for a finished session's branch. */
  async openPr(req: Request, res: Response): Promise<void> {
    try {
      const { id } = parse(sessionIdSchema, req.params);
      const { title, body } = parse(openPrBodySchema, req.body);
      const { orgId } = await this.actor(req);
      this.handleSuccess(res, await runnerSessionService.openPr(orgId, id, title, body), 201);
    } catch (error) {
      this.handleError(error, res, 'RunnerController.openPr');
    }
  }
}

export const runnerController = new RunnerController();
