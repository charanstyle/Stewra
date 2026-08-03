import type { Request, Response } from 'express';
import { z } from 'zod';
import { RUNNER_HARNESS_IDS } from '@stewra/shared-types';
import type { RunnerGitCredentialsResponse } from '@stewra/shared-types';
import { BaseController } from './baseController.js';
import { githubAppService } from '../services/githubAppService.js';
import { hostedRunnerService } from '../services/hostedRunnerService.js';
import { logger } from '../utils/logger.js';
import { parse } from '../utils/validate.js';

/**
 * The HTTP surface for Stewra-hosted cloud runners.
 *
 * Split from `runnerController` rather than bolted onto it because the two answer to different callers:
 * everything here that provisions or destroys is an account owner acting on infrastructure Stewra pays
 * for, and the two runner-facing endpoints are a CONTAINER asking for credentials. Keeping them in one
 * file with `runnerController`'s session verbs would put three different authentications side by side.
 *
 * NOTHING in this file logs a request body. The provision and credential routes carry a provider login
 * (a `claude setup-token` value), and one stray log line would put it in the host's journal forever.
 */

/**
 * Provider logins, keyed by harness. Bounded because they are forwarded to the provisioner and written
 * into a container's volume — a credential field that accepts arbitrary length is a file-write primitive.
 */
const provisionSchema = z.object({
  credentials: z
    .record(z.enum(RUNNER_HARNESS_IDS), z.string().min(1).max(8192))
    .optional(),
});

const harnessParamSchema = z.object({ harness: z.enum(RUNNER_HARNESS_IDS) });

const credentialBodySchema = z.object({ secret: z.string().min(1).max(8192) });

class HostedRunnerController extends BaseController {
  private userId(req: Request): string {
    const userId = req.userId;
    if (userId === undefined) throw new Error('requireAuth middleware missing');
    return userId;
  }

  /** The runner device behind a device-token request. Set by `requireRunnerDevice`. */
  private device(req: Request): { deviceId: string; userId: string } {
    const device = req.runnerDevice;
    if (device === undefined) throw new Error('requireRunnerDevice middleware missing');
    return device;
  }

  /** GET /runner/hosted — the user's cloud runner, or the absence of one, or "not offered here". */
  async status(req: Request, res: Response): Promise<void> {
    try {
      this.handleSuccess(res, await hostedRunnerService.getStatus(this.userId(req)));
    } catch (error) {
      this.handleError(error, res, 'HostedRunnerController.status');
    }
  }

  /** POST /runner/hosted — provision the container. The body's credentials are never logged or stored. */
  async provision(req: Request, res: Response): Promise<void> {
    try {
      const { credentials } = parse(provisionSchema, req.body);
      const runner = await hostedRunnerService.provision(this.userId(req), credentials ?? {});
      this.handleSuccess(res, { runner }, 201);
    } catch (error) {
      this.handleError(error, res, 'HostedRunnerController.provision');
    }
  }

  /** POST /runner/hosted/start — bring a stopped container back up. */
  async start(req: Request, res: Response): Promise<void> {
    try {
      this.handleSuccess(res, { runner: await hostedRunnerService.start(this.userId(req)) });
    } catch (error) {
      this.handleError(error, res, 'HostedRunnerController.start');
    }
  }

  /** POST /runner/hosted/stop — stop the container. Volumes untouched; always recoverable. */
  async stop(req: Request, res: Response): Promise<void> {
    try {
      this.handleSuccess(res, { runner: await hostedRunnerService.stop(this.userId(req)) });
    } catch (error) {
      this.handleError(error, res, 'HostedRunnerController.stop');
    }
  }

  /** DELETE /runner/hosted — destroy the container AND its volumes. The cloned work is gone for good. */
  async destroy(req: Request, res: Response): Promise<void> {
    try {
      const destroyed = await hostedRunnerService.destroy(this.userId(req));
      this.handleSuccess(res, { destroyed });
    } catch (error) {
      this.handleError(error, res, 'HostedRunnerController.destroy');
    }
  }

  /** PUT /runner/hosted/credentials/:harness — replace one harness's provider login. */
  async updateCredential(req: Request, res: Response): Promise<void> {
    try {
      const { harness } = parse(harnessParamSchema, req.params);
      const { secret } = parse(credentialBodySchema, req.body);
      await hostedRunnerService.updateProviderCredential(this.userId(req), harness, secret);
      this.handleSuccess(res, { ok: true });
    } catch (error) {
      this.handleError(error, res, 'HostedRunnerController.updateCredential');
    }
  }

  // ── Runner-facing (device token; hosted devices only — enforced by requireHostedRunnerDevice) ────────

  /**
   * POST /runner/git-credentials — a hosted runner asking for a git credential, per operation.
   *
   * Called by the runner's `git-credential` helper, so this runs on every clone, fetch, and push. The
   * token it returns lives about an hour and is never written to the container's disk: asking again is
   * cheaper than storing, and it means uninstalling the GitHub App cuts access at the next request.
   */
  async gitCredentials(req: Request, res: Response): Promise<void> {
    try {
      const { deviceId, userId } = this.device(req);
      const { token, expiresAt } = await githubAppService.mintInstallationToken(userId);
      const body: RunnerGitCredentialsResponse = {
        username: 'x-access-token',
        token,
        expiresAt: expiresAt.toISOString(),
      };
      // Deviceid and expiry only — the token itself is the one thing that must never reach a log.
      logger.debug('hosted-runner: minted a git credential', { deviceId, expiresAt: body.expiresAt });
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'HostedRunnerController.gitCredentials');
    }
  }

  /** GET /runner/hosted/workspaces — what a hosted runner should clone, read live from the installation. */
  async workspaces(req: Request, res: Response): Promise<void> {
    try {
      const { userId } = this.device(req);
      this.handleSuccess(res, { workspaces: await hostedRunnerService.listWorkspaces(userId) });
    } catch (error) {
      this.handleError(error, res, 'HostedRunnerController.workspaces');
    }
  }
}

export const hostedRunnerController = new HostedRunnerController();
