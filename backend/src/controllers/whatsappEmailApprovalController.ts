import type { Request, Response } from 'express';
import { z } from 'zod';
import type {
  GetEmailOverWhatsappResponse,
  SetEmailOverWhatsappResponse,
} from '@stewra/shared-types';
import { BaseController } from './baseController.js';
import { whatsappEmailApprovalService } from '../services/whatsappEmailApprovalService.js';
import { parse } from '../utils/validate.js';

/**
 * `password` is optional at the schema level because it is only needed to turn the opt-in ON; the
 * service enforces its presence there by re-verifying it. It is capped so the endpoint can't be used to
 * shovel arbitrary-length strings at bcrypt.
 */
const setSchema = z.object({
  enabled: z.boolean(),
  password: z.string().min(1).max(512).optional(),
});

/**
 * Approve-to-send email over WhatsApp (`whatsapp_email_approval`) — the per-user opt-in toggle.
 *
 * Both routes run behind `requireAuth`. Enabling additionally requires the account password, which the
 * SERVICE re-verifies; this controller takes no `confirmed: true` flag, because a client asserting the
 * user re-authenticated is not evidence that they did (same principle as the typed-consent controller).
 */
class WhatsappEmailApprovalController extends BaseController {
  private userId(req: Request): string {
    const userId = req.userId;
    if (userId === undefined) throw new Error('requireAuth middleware missing');
    return userId;
  }

  /** GET /channels/whatsapp-email-approval — deploy switch + the user's opt-in state. */
  async status(req: Request, res: Response): Promise<void> {
    try {
      const body: GetEmailOverWhatsappResponse = await whatsappEmailApprovalService.getStatus(
        this.userId(req),
      );
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'WhatsappEmailApprovalController.status');
    }
  }

  /** POST /channels/whatsapp-email-approval — turn the opt-in on (password-gated) or off. */
  async set(req: Request, res: Response): Promise<void> {
    try {
      // `parse`, not `setSchema.parse`: a raw ZodError escapes as a 500 with a Sentry event, because
      // BaseController.handleError has no ZodError branch. A malformed body is the caller's mistake
      // and must read as 400.
      const { enabled, password } = parse(setSchema, req.body);
      const result: SetEmailOverWhatsappResponse = await whatsappEmailApprovalService.setEnabled(
        this.userId(req),
        enabled,
        password,
      );
      this.handleSuccess(res, result);
    } catch (error) {
      this.handleError(error, res, 'WhatsappEmailApprovalController.set');
    }
  }
}

export const whatsappEmailApprovalController = new WhatsappEmailApprovalController();
