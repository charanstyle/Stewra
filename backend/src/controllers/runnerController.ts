import type { Request, Response } from 'express';
import { z } from 'zod';
import { BaseController } from './baseController.js';
import { runnerService } from '../services/runnerService.js';

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

/**
 * The Stewra Runner surface (`/runner`).
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

  /** GET /runner — feature availability + the user's runners, for the "Runners" panel. */
  async status(req: Request, res: Response): Promise<void> {
    try {
      this.handleSuccess(res, await runnerService.getStatus(this.userId(req)));
    } catch (error) {
      this.handleError(error, res, 'RunnerController.status');
    }
  }

  /** GET /runner/devices — the user's runners with live online state. */
  async listDevices(req: Request, res: Response): Promise<void> {
    try {
      this.handleSuccess(res, await runnerService.listDevices(this.userId(req)));
    } catch (error) {
      this.handleError(error, res, 'RunnerController.listDevices');
    }
  }

  /** POST /runner/pair — mint the single-use code the user pastes into `stewra-runner pair <code>`. */
  async startPairing(req: Request, res: Response): Promise<void> {
    try {
      const result = await runnerService.startPairing(this.userId(req));
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
      const body = claimSchema.parse(req.body);
      const result = await runnerService.claimToken(body);
      this.handleSuccess(res, result, 201);
    } catch (error) {
      this.handleError(error, res, 'RunnerController.claimToken');
    }
  }

  /** DELETE /runner/devices/:id — kill a runner's token immediately. */
  async revokeDevice(req: Request, res: Response): Promise<void> {
    try {
      const { id } = deviceIdSchema.parse(req.params);
      const revoked = await runnerService.revokeDevice(this.userId(req), id);
      this.handleSuccess(res, { revoked });
    } catch (error) {
      this.handleError(error, res, 'RunnerController.revokeDevice');
    }
  }
}

export const runnerController = new RunnerController();
