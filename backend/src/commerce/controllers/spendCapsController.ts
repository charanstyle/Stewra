import type { Request, Response } from 'express';
import { z } from 'zod';
import type {
  GetOrgSpendResponse,
  ListSpendCapsResponse,
  SetSpendCapResponse,
} from '@stewra/shared-types';
import { BaseController } from '../../controllers/baseController.js';
import { spendCapService } from '../services/spendCapService.js';
import { orgContext } from '../middleware/requireOrgMember.js';
import { parse } from '../../utils/validate.js';
import { AuthenticationError } from '../../utils/errors.js';

const setCapSchema = z.object({
  orgId: z.string().uuid(),
  currency: z.string().regex(/^[A-Z]{3}$/, 'currency must be an uppercase ISO 4217 code'),
  // A decimal string of micros, never a JSON number (bigint territory). 15 digits is a billion
  // currency units — anything longer is a pasted mistake, not a limit.
  limitMicros: z.string().regex(/^\d{1,15}$/, 'limitMicros must be a digits-only string'),
  note: z.string().min(1).max(2000),
});

const listCapsSchema = z.object({
  orgId: z.string().uuid(),
});

/**
 * The two faces of the spend cap, deliberately unequal.
 *
 * `set`/`list` are platform-operator surface (`/platform/spend-caps`, behind
 * `requireInstallAdmin`): headroom is granted by whoever carries the Meta bill, and a client must
 * never raise their own allowance before paying. `orgSpend` is the org-facing READ
 * (`/orgs/:orgId/spend`, ordinary member auth): a campaign paused by the cap needs its explanation
 * visible to the people watching the campaign, but nothing on that surface can change a limit.
 */
class SpendCapsController extends BaseController {
  /** PUT /platform/spend-caps */
  async set(req: Request, res: Response): Promise<void> {
    try {
      if (req.userId === undefined) throw new AuthenticationError('Authentication required');
      const body = parse(setCapSchema, req.body);
      const cap = await spendCapService.setCap({
        orgId: body.orgId,
        currency: body.currency,
        limitMicros: body.limitMicros,
        note: body.note,
        grantedByUserId: req.userId,
      });
      const response: SetSpendCapResponse = { cap };
      this.handleSuccess(res, response);
    } catch (error) {
      this.handleError(error, res, 'SpendCapsController.set');
    }
  }

  /** GET /platform/spend-caps?orgId= */
  async list(req: Request, res: Response): Promise<void> {
    try {
      const query = parse(listCapsSchema, req.query);
      const [caps, usage] = await Promise.all([
        spendCapService.listCaps(query.orgId),
        spendCapService.usage(query.orgId),
      ]);
      const response: ListSpendCapsResponse = { caps, usage };
      this.handleSuccess(res, response);
    } catch (error) {
      this.handleError(error, res, 'SpendCapsController.list');
    }
  }

  /** GET /orgs/:orgId/spend */
  async orgSpend(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const usage = await spendCapService.usage(orgId);
      const response: GetOrgSpendResponse = { usage };
      this.handleSuccess(res, response);
    } catch (error) {
      this.handleError(error, res, 'SpendCapsController.orgSpend');
    }
  }
}

export const spendCapsController = new SpendCapsController();
