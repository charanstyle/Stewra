import type { Request, Response } from 'express';
import { z } from 'zod';
import type {
  CreateChannelAccountResponse,
  DeleteChannelAccountResponse,
  EmbeddedSignupConfig,
  ListChannelAccountsResponse,
} from '@stewra/shared-types';
import { BaseController } from '../../controllers/baseController.js';
import { channelAccountService } from '../services/channelAccountService.js';
import { metaEmbeddedSignupService } from '../services/metaEmbeddedSignupService.js';
import { orgContext } from '../../tenancy/middleware/requireOrgMember.js';
import { config } from '../../config/unifiedConfig.js';
import { parse } from '../../utils/validate.js';

const connectSchema = z.object({
  code: z.string().min(1).max(1024),
  // Exactly six digits, because that is what Meta accepts — rejecting a malformed PIN here saves a
  // wasted attempt against Meta's own lockout counter, which locks two-step verification for hours.
  pin: z.string().regex(/^\d{6}$/, 'The PIN is six digits').optional(),
});
const accountParamsSchema = z.object({ accountId: z.string().uuid() });

/** An organization's connected messaging accounts, and the Embedded Signup flow that creates them. */
class ChannelsController extends BaseController {
  /** GET /orgs/:orgId/channels */
  async list(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const accounts = await channelAccountService.listForOrg(orgId);
      // Null rather than a placeholder object when the integration is off: the website must be able
      // to tell "this deploy cannot connect WhatsApp" from "connect it here", and an app id of ''
      // would open Meta's dialog on nothing.
      const signup: EmbeddedSignupConfig | null = config.metaCommerce.enabled
        ? metaEmbeddedSignupService.publicConfig()
        : null;
      const body: ListChannelAccountsResponse = { accounts, signup };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'ChannelsController.list');
    }
  }

  /** POST /orgs/:orgId/channels/whatsapp — finish an Embedded Signup with the returned code. */
  async connectWhatsapp(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const { code, pin } = parse(connectSchema, req.body);
      const account = await metaEmbeddedSignupService.connect({ orgId, code, pin });
      const body: CreateChannelAccountResponse = { account };
      this.handleSuccess(res, body, 201);
    } catch (error) {
      this.handleError(error, res, 'ChannelsController.connectWhatsapp');
    }
  }

  /** DELETE /orgs/:orgId/channels/:accountId */
  async disconnect(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const { accountId } = parse(accountParamsSchema, req.params);
      const disconnected = await channelAccountService.disconnect(orgId, accountId);
      const body: DeleteChannelAccountResponse = { disconnected };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'ChannelsController.disconnect');
    }
  }
}

export const channelsController = new ChannelsController();
