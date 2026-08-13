import type { Request, Response } from 'express';
import { z } from 'zod';
import { CONSENT_PURPOSES } from '@stewra/shared-types';
import type {
  CreateOptinLinkResponse,
  DisableOptinLinkResponse,
  ListOptinLinksResponse,
} from '@stewra/shared-types';
import { BaseController } from '../../controllers/baseController.js';
import { optinLinkService } from '../services/optinLinkService.js';
import { orgContext } from '../middleware/requireOrgMember.js';
import { parse } from '../../utils/validate.js';

const linkParamsSchema = z.object({ linkId: z.string().uuid() });

const createLinkSchema = z.object({
  channelAccountId: z.string().uuid(),
  name: z.string().min(1).max(120),
  purpose: z.enum(CONSENT_PURPOSES),
  // Bounds only. The substantive rules — no embedded reference code, non-empty after trimming — live
  // in the service, next to the reason they exist.
  phrase: z.string().min(1).max(200),
});

/**
 * Click-to-WhatsApp opt-in links.
 *
 * Minting is `admin` and reading is `viewer`, matching the rest of the audience surface. The line
 * falls in the same place for the same reason: publishing a link is deciding what an organization
 * will tell the public it is collecting permission for, which is a statement the organization is
 * answerable for rather than a step in answering a message.
 *
 * Disabling is `admin` too, though the instinct is to make retiring something cheaper than creating
 * it. It is not cheaper here — a live link is very likely printed on packaging, and switching it off
 * silently strands every customer who scans it afterwards.
 */
class OptinLinksController extends BaseController {
  /** POST /orgs/:orgId/optin-links */
  async create(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const userId = req.userId;
      if (userId === undefined) throw new Error('requireAuth middleware missing');

      const input = parse(createLinkSchema, req.body);
      const link = await optinLinkService.create({
        orgId,
        createdByUserId: userId,
        channelAccountId: input.channelAccountId,
        name: input.name,
        purpose: input.purpose,
        phrase: input.phrase,
      });

      const body: CreateOptinLinkResponse = { link };
      this.handleSuccess(res, body, 201);
    } catch (error) {
      this.handleError(error, res, 'OptinLinksController.create');
    }
  }

  /** GET /orgs/:orgId/optin-links */
  async list(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const links = await optinLinkService.listForOrg(orgId);
      const body: ListOptinLinksResponse = { links };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'OptinLinksController.list');
    }
  }

  /** POST /orgs/:orgId/optin-links/:linkId/disable */
  async disable(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const { linkId } = parse(linkParamsSchema, req.params);
      const link = await optinLinkService.disable(orgId, linkId);
      const body: DisableOptinLinkResponse = { link };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'OptinLinksController.disable');
    }
  }
}

export const optinLinksController = new OptinLinksController();
