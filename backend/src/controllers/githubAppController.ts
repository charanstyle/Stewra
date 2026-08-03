import type { Request, Response } from 'express';
import { z } from 'zod';
import type { UnlinkGithubInstallationResponse } from '@stewra/shared-types';
import { BaseController } from './baseController.js';
import { githubAppService } from '../services/githubAppService.js';

/**
 * `installationId` arrives from a redirect query parameter via the setup page — bounded and integral, or
 * it never reaches the service. `state` is the signed token the service itself minted; its size is
 * bounded here only so the endpoint is not a text dump.
 */
const linkSchema = z.object({
  installationId: z.number().int().positive(),
  state: z.string().min(1).max(2048),
});

/**
 * The Stewra GitHub App surface (`/github-app`) — how a user grants the hosted runner click-through
 * access to chosen repositories. Everything here runs behind `requireAuth`; linking additionally
 * requires a verified email (wired in the routes), the same bar as pairing a runner.
 */
class GithubAppController extends BaseController {
  private userId(req: Request): string {
    const userId = req.userId;
    if (userId === undefined) throw new Error('requireAuth middleware missing');
    return userId;
  }

  /** GET /github-app — configured/installed state, the install URL, and the granted repositories. */
  async status(req: Request, res: Response): Promise<void> {
    try {
      this.handleSuccess(res, await githubAppService.getStatus(this.userId(req)));
    } catch (error) {
      this.handleError(error, res, 'GithubAppController.status');
    }
  }

  /** POST /github-app/installations — link the installation GitHub redirected back with. */
  async link(req: Request, res: Response): Promise<void> {
    try {
      const body = linkSchema.parse(req.body);
      this.handleSuccess(
        res,
        await githubAppService.linkInstallation(this.userId(req), body.installationId, body.state),
      );
    } catch (error) {
      this.handleError(error, res, 'GithubAppController.link');
    }
  }

  /** DELETE /github-app/installations — forget the link (and best-effort uninstall on GitHub). */
  async unlink(req: Request, res: Response): Promise<void> {
    try {
      await githubAppService.unlink(this.userId(req));
      const body: UnlinkGithubInstallationResponse = { unlinked: true };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'GithubAppController.unlink');
    }
  }
}

export const githubAppController = new GithubAppController();
