import type { Request, Response } from 'express';
import { z } from 'zod';
import { BaseController } from './baseController.js';
import { whatsappPersonalService } from '../services/whatsappPersonalService.js';

/**
 * `sentence` is capped at a sane length rather than left unbounded: it is echoed back into an audit row,
 * and an endpoint that stores whatever text you POST is a storage-abuse vector, not just untidy.
 */
const consentSchema = z.object({
  sentence: z.string().min(1).max(500),
});

const claimSchema = z.object({
  code: z.string().min(1).max(32),
  deviceName: z.string().min(1).max(64),
  appVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
});

const deviceIdSchema = z.object({
  id: z.string().uuid(),
});

/**
 * The EXPERIMENTAL companion-device WhatsApp channel (`whatsapp_personal`).
 *
 * Note the split in authentication: everything here runs behind `requireAuth` EXCEPT `claimToken`, which
 * is called by the Stewra Bridge desktop app and authenticates with a single-use pairing code instead.
 * That is deliberate — handing a desktop app the user's access token would give it the entire account
 * when all it needs is permission to relay WhatsApp messages.
 */
class WhatsappPersonalController extends BaseController {
  private userId(req: Request): string {
    const userId = req.userId;
    if (userId === undefined) throw new Error('requireAuth middleware missing');
    return userId;
  }

  /** GET /channels/whatsapp-personal — consent state + linked devices, for the "Your sources" panel. */
  async status(req: Request, res: Response): Promise<void> {
    try {
      this.handleSuccess(res, await whatsappPersonalService.getStatus(this.userId(req)));
    } catch (error) {
      this.handleError(error, res, 'WhatsappPersonalController.status');
    }
  }

  /**
   * POST /channels/whatsapp-personal/consent — the typed acknowledgement.
   *
   * The service re-checks the sentence against the shared constant. This controller deliberately does
   * NOT accept any kind of `confirmed: true` flag: the only evidence we take is the words themselves.
   */
  async consent(req: Request, res: Response): Promise<void> {
    try {
      const body = consentSchema.parse(req.body);
      const result = await whatsappPersonalService.grantConsent(this.userId(req), body.sentence);
      this.handleSuccess(res, result, 201);
    } catch (error) {
      this.handleError(error, res, 'WhatsappPersonalController.consent');
    }
  }

  /** POST /channels/whatsapp-personal/pair — mint the code the user types into the bridge app. */
  async startPairing(req: Request, res: Response): Promise<void> {
    try {
      const result = await whatsappPersonalService.startPairing(this.userId(req));
      this.handleSuccess(res, result, 201);
    } catch (error) {
      this.handleError(error, res, 'WhatsappPersonalController.startPairing');
    }
  }

  /**
   * POST /channels/whatsapp-personal/bridge-token — called by the BRIDGE APP, not the web client.
   * Unauthenticated by design; the pairing code is the credential, and it is burned on use.
   */
  async claimToken(req: Request, res: Response): Promise<void> {
    try {
      const body = claimSchema.parse(req.body);
      const result = await whatsappPersonalService.claimBridgeToken(body);
      this.handleSuccess(res, result, 201);
    } catch (error) {
      this.handleError(error, res, 'WhatsappPersonalController.claimToken');
    }
  }

  /** DELETE /channels/whatsapp-personal/devices/:id — kill a bridge's token immediately. */
  async revokeDevice(req: Request, res: Response): Promise<void> {
    try {
      const { id } = deviceIdSchema.parse(req.params);
      const revoked = await whatsappPersonalService.revokeDevice(this.userId(req), id);
      this.handleSuccess(res, { revoked });
    } catch (error) {
      this.handleError(error, res, 'WhatsappPersonalController.revokeDevice');
    }
  }
}

export const whatsappPersonalController = new WhatsappPersonalController();
