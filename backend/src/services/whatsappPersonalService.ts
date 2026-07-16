import type {
  BridgeDevice,
  ClaimBridgeTokenRequest,
  ClaimBridgeTokenResponse,
  GetWhatsappPersonalResponse,
  GrantWhatsappPersonalConsentResponse,
  StartBridgePairingResponse,
} from '@stewra/shared-types';
import {
  WHATSAPP_PERSONAL_CONSENT_SENTENCE,
  WHATSAPP_PERSONAL_CONSENT_VERSION,
  isConsentSentenceValid,
} from '@stewra/shared-types';
import { config } from '../config/unifiedConfig.js';
import { auditWriter } from '../control-plane/audit/auditWriter.js';
import { bridgeDeviceRepository } from '../repositories/bridgeDeviceRepository.js';
import { channelIdentityRepository } from '../repositories/channelIdentityRepository.js';
import { notifyRevoked } from '../websocket/bridgeEmitter.js';
import { AuthenticationError, ForbiddenError, ServiceUnavailableError, ValidationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const CHANNEL = 'whatsapp_personal' as const;

/** Compare `a.b.c` version triples numerically. Returns true when `version` is at least `minimum`. */
function meetsMinimumVersion(version: string, minimum: string): boolean {
  const parse = (v: string): number[] => v.split('.').map((p) => Number.parseInt(p, 10));
  const got = parse(version);
  const want = parse(minimum);
  if (got.some(Number.isNaN) || got.length !== 3) return false;
  for (let i = 0; i < 3; i += 1) {
    const g = got[i] ?? 0;
    const w = want[i] ?? 0;
    if (g > w) return true;
    if (g < w) return false;
  }
  return true;
}

/**
 * The EXPERIMENTAL companion-device channel: the user's own WhatsApp account, reached through the Stewra
 * Bridge app on the user's own computer.
 *
 * This service owns the gate, and only the gate. It never talks to WhatsApp — nothing in this process
 * ever does (build-plan principle 7). Its job is to be certain that a bridge which claims to speak for a
 * user was authorised, in this order, by:
 *
 *   1. that user typing the consent sentence, verified HERE, against the shared constant; then
 *   2. a single-use pairing code minted only for a consented user; then
 *   3. a device token that the user can revoke from the web app at any moment.
 *
 * Each step is checked server-side. A client that says "the user confirmed" is telling us nothing.
 */
class WhatsappPersonalService {
  private assertEnabled(): void {
    if (!config.whatsappPersonal.enabled) {
      throw new ServiceUnavailableError('The experimental WhatsApp channel is not available');
    }
  }

  /**
   * Record the user's typed acknowledgement.
   *
   * The sentence is re-validated here, server-side, and this is the load-bearing line of the feature.
   * The frontend will of course check it too, for a decent error message — but a frontend check is a
   * courtesy to honest users, not a control. Anyone can POST `{"sentence": "yes"}`. What makes the
   * consent real is that THIS function compares what arrived against the exact words in shared-types,
   * and stores them verbatim.
   */
  async grantConsent(userId: string, sentence: string): Promise<GrantWhatsappPersonalConsentResponse> {
    this.assertEnabled();

    if (!isConsentSentenceValid(sentence)) {
      throw new ValidationError('The acknowledgement was not typed correctly', [
        { field: 'sentence', message: `You must type: "${WHATSAPP_PERSONAL_CONSENT_SENTENCE}"` },
      ]);
    }

    const consentedAt = await bridgeDeviceRepository.recordConsent(
      userId,
      WHATSAPP_PERSONAL_CONSENT_VERSION,
      sentence.trim(),
    );

    await auditWriter.write({
      userId,
      action: 'consent',
      resourceType: 'channel',
      resourceId: CHANNEL,
      summary:
        'You acknowledged that linking your personal WhatsApp account can get it permanently banned.',
      success: true,
      metadata: { channel: CHANNEL, consentVersion: WHATSAPP_PERSONAL_CONSENT_VERSION },
    });

    return { version: WHATSAPP_PERSONAL_CONSENT_VERSION, consentedAt: consentedAt.toISOString() };
  }

  /**
   * Mint the code the user types into the bridge app.
   *
   * Refuses unless the user holds a CURRENT-version consent. That check is what lets every later step
   * treat a valid code as proof of consent: by the time a bridge redeems one, the words have already
   * been typed and recorded. If we bump the sentence, everyone re-types it before they can pair again —
   * which is the entire reason the version exists.
   */
  async startPairing(userId: string): Promise<StartBridgePairingResponse> {
    this.assertEnabled();

    const consented = await bridgeDeviceRepository.findConsent(
      userId,
      WHATSAPP_PERSONAL_CONSENT_VERSION,
    );
    if (consented === null) {
      throw new ForbiddenError('You must acknowledge the risks before linking a device');
    }

    const { code, expiresAt } = await channelIdentityRepository.createLinkCode(
      CHANNEL,
      userId,
      config.whatsapp.linkCodeTtlMs,
    );

    return {
      code,
      expiresAt: expiresAt.toISOString(),
      downloadUrl: config.whatsappPersonal.downloadUrl,
    };
  }

  /**
   * Called BY THE BRIDGE APP, holding only a pairing code. Burns the code and mints the device token.
   *
   * This is the one endpoint here that is not behind `requireAuth` — the bridge has no user session, and
   * shouldn't: giving a desktop app the user's access token would hand it the whole account, when all it
   * needs is permission to relay messages. The code IS the authentication, which is why it is single-use,
   * short-lived, and burned atomically before anything else happens.
   */
  async claimBridgeToken(req: ClaimBridgeTokenRequest): Promise<ClaimBridgeTokenResponse> {
    this.assertEnabled();

    // Refuse a build too old to be safe BEFORE burning the code — otherwise a user on an old bridge
    // spends their code, gets rejected, and has to go back to the web app to mint another one.
    if (!meetsMinimumVersion(req.appVersion, config.whatsappPersonal.minBridgeVersion)) {
      throw new ForbiddenError(
        `This version of Stewra Bridge is out of date. Please update to ${config.whatsappPersonal.minBridgeVersion} or later.`,
      );
    }

    const userId = await channelIdentityRepository.consumeCode(CHANNEL, req.code);
    if (userId === null) {
      throw new AuthenticationError('That pairing code is invalid, expired, or already used');
    }

    // Re-read the consent rather than trusting the code's existence. Belt and braces: the code proves
    // consent only because `startPairing` refused to mint it otherwise, and that invariant should be
    // enforced at the point it is relied upon, not assumed across a call boundary.
    const consentedAt = await bridgeDeviceRepository.findConsent(
      userId,
      WHATSAPP_PERSONAL_CONSENT_VERSION,
    );
    if (consentedAt === null) {
      throw new ForbiddenError('You must acknowledge the risks before linking a device');
    }

    const { device, token } = await bridgeDeviceRepository.registerDevice({
      userId,
      name: req.deviceName.trim().slice(0, 64),
      appVersion: req.appVersion,
      consentVersion: WHATSAPP_PERSONAL_CONSENT_VERSION,
      consentedAt,
    });

    await auditWriter.write({
      userId,
      action: 'connect',
      resourceType: 'channel',
      resourceId: device.id,
      summary: `You linked "${device.name}" as a Stewra Bridge for your personal WhatsApp.`,
      success: true,
      metadata: { channel: CHANNEL, deviceId: device.id, appVersion: req.appVersion },
    });

    logger.info('whatsapp-personal: bridge device registered', {
      userId,
      deviceId: device.id,
      appVersion: req.appVersion,
    });

    return { token, device };
  }

  /**
   * Authenticate a raw bridge token. The `/bridge` namespace's middleware (Phase 2) is the only caller.
   * Returns null rather than throwing, because the socket layer wants to reject quietly, not 500.
   */
  async authenticateBridge(token: string): Promise<{ deviceId: string; userId: string } | null> {
    if (!config.whatsappPersonal.enabled) return null;
    return bridgeDeviceRepository.findByToken(token);
  }

  /** Everything the web panel renders, including whether the feature exists on this deploy at all. */
  async getStatus(userId: string): Promise<GetWhatsappPersonalResponse> {
    // NOT gated on `assertEnabled`: the panel has to be able to ask "is this available?" and get an
    // answer rather than an error. Every mutating path above refuses when disabled.
    const enabled = config.whatsappPersonal.enabled;
    const [consentVersion, devices] = await Promise.all([
      bridgeDeviceRepository.latestConsentVersion(userId),
      enabled ? bridgeDeviceRepository.listByUser(userId) : Promise.resolve<BridgeDevice[]>([]),
    ]);

    return {
      enabled,
      consentVersion,
      currentConsentVersion: WHATSAPP_PERSONAL_CONSENT_VERSION,
      devices,
      downloadUrl: config.whatsappPersonal.downloadUrl,
    };
  }

  /**
   * Revoke a bridge. Instant — and the reason bridge tokens are database rows rather than JWTs.
   *
   * Revoking the user's LAST bridge also purges their stored WhatsApp content (see the repository): with
   * no bridge, nothing can reach their WhatsApp and nothing new can arrive, so keeping forwarded message
   * bodies would be holding third-party content for no purpose.
   *
   * Note what this does NOT do: it cannot unlink Stewra Bridge from the user's WhatsApp ACCOUNT, because
   * that session lives on their own machine and we have no access to it — which is the whole design. The
   * app tears itself down when it sees the revocation, but the authority here is the user's own phone
   * (WhatsApp → Linked Devices), and the UI must say so rather than implying we can reach into their
   * account and pull the session ourselves.
   */
  async revokeDevice(userId: string, deviceId: string): Promise<boolean> {
    this.assertEnabled();
    const revoked = await bridgeDeviceRepository.revoke(userId, deviceId);

    if (revoked) {
      // The token row is already gone, so the device can never reconnect. This tells it to stop NOW —
      // and to wipe the WhatsApp session it is holding — instead of continuing on its open socket.
      await notifyRevoked(userId, deviceId);

      await auditWriter.write({
        userId,
        action: 'disconnect',
        resourceType: 'channel',
        resourceId: deviceId,
        summary: 'You revoked a Stewra Bridge device.',
        success: true,
        metadata: { channel: CHANNEL, deviceId },
      });
    }
    return revoked;
  }
}

export const whatsappPersonalService = new WhatsappPersonalService();
