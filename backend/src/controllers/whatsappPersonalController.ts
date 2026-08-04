import type { Request, Response } from 'express';
import { z } from 'zod';
import type {
  ClaimBridgeTokenResponse,
  GetWhatsappPersonalResponse,
  GrantWhatsappPersonalConsentResponse,
  RevokeBridgeDeviceResponse,
  StartBridgePairingResponse,
} from '@stewra/shared-types';
import { BaseController } from './baseController.js';
import { whatsappPersonalService } from '../services/whatsappPersonalService.js';
import { parse } from '../utils/validate.js';

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
      const body: GetWhatsappPersonalResponse = await whatsappPersonalService.getStatus(
        this.userId(req),
      );
      this.handleSuccess(res, body);
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
      // `parse`, not `consentSchema.parse`: a raw ZodError reaches BaseController.handleError, which
      // has no ZodError branch, so a malformed body became a 500 plus a spurious Sentry alert.
      const { sentence } = parse(consentSchema, req.body);
      const result: GrantWhatsappPersonalConsentResponse =
        await whatsappPersonalService.grantConsent(this.userId(req), sentence);
      this.handleSuccess(res, result, 201);
    } catch (error) {
      this.handleError(error, res, 'WhatsappPersonalController.consent');
    }
  }

  /** POST /channels/whatsapp-personal/pair — mint the code the user types into the bridge app. */
  async startPairing(req: Request, res: Response): Promise<void> {
    try {
      const result: StartBridgePairingResponse = await whatsappPersonalService.startPairing(
        this.userId(req),
      );
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
      // Unauthenticated route: a malformed body here is the most likely thing a stranger sends, and
      // it must cost a 400, not a 500 and an alert.
      const body = parse(claimSchema, req.body);
      const result: ClaimBridgeTokenResponse = await whatsappPersonalService.claimBridgeToken(body);
      this.handleSuccess(res, result, 201);
    } catch (error) {
      this.handleError(error, res, 'WhatsappPersonalController.claimToken');
    }
  }

  /** DELETE /channels/whatsapp-personal/devices/:id — kill a bridge's token immediately. */
  async revokeDevice(req: Request, res: Response): Promise<void> {
    try {
      // A non-UUID in the path is a 400 too — same reasoning as the bodies above.
      const { id } = parse(deviceIdSchema, req.params);
      const revoked = await whatsappPersonalService.revokeDevice(this.userId(req), id);
      const body: RevokeBridgeDeviceResponse = { revoked };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'WhatsappPersonalController.revokeDevice');
    }
  }
}

export const whatsappPersonalController = new WhatsappPersonalController();
