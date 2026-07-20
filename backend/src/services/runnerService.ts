import type {
  ClaimRunnerTokenRequest,
  ClaimRunnerTokenResponse,
  GetRunnerStatusResponse,
  ListRunnerDevicesResponse,
  RunnerHarnessInfo,
  RunnerWorkspace,
  StartRunnerPairingResponse,
} from '@stewra/shared-types';
import { config } from '../config/unifiedConfig.js';
import { auditWriter } from '../control-plane/audit/auditWriter.js';
import { runnerDeviceRepository } from '../repositories/runnerDeviceRepository.js';
import { listOnlineDeviceIds, notifyRunnerRevoked } from '../websocket/runnerEmitter.js';
import { AuthenticationError, ForbiddenError, ServiceUnavailableError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/** Compare `a.b.c` version triples numerically. True when `version` is at least `minimum`. */
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
 * The Stewra Runner surface: a process on the user's OWN machine that hosts coding agents and runs them
 * against the user's repositories. This service owns the gate, and only the gate — it never spawns an
 * agent or touches a repo (that is the runner's job, on the user's box). Its concern is that a runner
 * claiming to speak for a user was authorised by:
 *
 *   1. that user, while authenticated, minting a single-use pairing code; then
 *   2. that code being redeemed exactly once for a device token the user can revoke at any moment.
 *
 * Modelled on `whatsappPersonalService`, minus the typed-consent step: a runner runs on the user's own
 * machine under their own logins (the risk profile is "code runs on my computer", not "my WhatsApp account
 * gets banned"), so the account-owner gate is the pairing code rather than a typed acknowledgement.
 */
class RunnerService {
  private assertEnabled(): void {
    if (!config.runner.enabled) {
      throw new ServiceUnavailableError('The Stewra Runner feature is not available');
    }
  }

  /** Mint the single-use code the user pastes into `stewra-runner pair <code>`. */
  async startPairing(userId: string): Promise<StartRunnerPairingResponse> {
    this.assertEnabled();
    const { code, expiresAt } = await runnerDeviceRepository.mintPairCode(
      userId,
      config.runner.pairCodeTtlMs,
    );
    return { code, expiresAt: expiresAt.toISOString(), downloadUrl: config.runner.downloadUrl };
  }

  /**
   * Called BY THE RUNNER, holding only a pairing code. Burns the code and mints the device token. Not
   * behind `requireAuth` — the runner has no user session, and shouldn't: the code IS the credential.
   */
  async claimToken(req: ClaimRunnerTokenRequest): Promise<ClaimRunnerTokenResponse> {
    this.assertEnabled();

    // Refuse a build too old to be safe BEFORE burning the code — otherwise the user spends their code,
    // gets rejected, and has to mint another.
    if (!meetsMinimumVersion(req.appVersion, config.runner.minVersion)) {
      throw new ForbiddenError(
        `This version of Stewra Runner is out of date. Please update to ${config.runner.minVersion} or later.`,
      );
    }

    const userId = await runnerDeviceRepository.consumePairCode(req.code);
    if (userId === null) {
      throw new AuthenticationError('That pairing code is invalid, expired, or already used');
    }

    const { device, token } = await runnerDeviceRepository.registerDevice({
      userId,
      name: req.deviceName.trim().slice(0, 64),
      appVersion: req.appVersion,
      os: req.os.trim().slice(0, 32),
    });

    await auditWriter.write({
      userId,
      action: 'connect',
      resourceType: 'system',
      resourceId: device.id,
      summary: `You linked "${device.name}" as a Stewra Runner (can run coding agents on that machine).`,
      success: true,
      metadata: { deviceId: device.id, appVersion: req.appVersion, os: device.os },
    });

    logger.info('runner: device registered', { userId, deviceId: device.id, appVersion: req.appVersion });
    return { token, device };
  }

  /**
   * Authenticate a raw runner token. The `/runner` namespace's middleware is the only caller. Returns null
   * rather than throwing, because the socket layer wants to reject quietly, not 500.
   */
  async authenticateRunner(token: string): Promise<{ deviceId: string; userId: string } | null> {
    if (!config.runner.enabled) return null;
    return runnerDeviceRepository.findByToken(token);
  }

  /** Persist a runner's reported capabilities + liveness (driven by `runner:hello`). */
  async recordCapabilities(
    deviceId: string,
    params: {
      os: string;
      harnesses: readonly RunnerHarnessInfo[];
      workspaces: readonly RunnerWorkspace[];
    },
  ): Promise<void> {
    await runnerDeviceRepository.updateCapabilities(deviceId, params);
  }

  /** The user's runners, with a truthful `online` state composed from who is actually connected. */
  async listDevices(userId: string): Promise<ListRunnerDevicesResponse> {
    const onlineIds = config.runner.enabled ? await listOnlineDeviceIds(userId) : new Set<string>();
    const devices = await runnerDeviceRepository.listByUser(userId, onlineIds);
    return { devices };
  }

  /** Everything the "Runners" panel renders, including whether the feature exists on this deploy. */
  async getStatus(userId: string): Promise<GetRunnerStatusResponse> {
    // NOT gated on `assertEnabled`: the panel must be able to ask "is this available?" and get an answer.
    const enabled = config.runner.enabled;
    if (!enabled) {
      return { enabled, devices: [], downloadUrl: config.runner.downloadUrl };
    }
    const onlineIds = await listOnlineDeviceIds(userId);
    const devices = await runnerDeviceRepository.listByUser(userId, onlineIds);
    return { enabled, devices, downloadUrl: config.runner.downloadUrl };
  }

  /** Revoke a runner. Instant — the reason runner tokens are database rows, not JWTs. */
  async revokeDevice(userId: string, deviceId: string): Promise<boolean> {
    this.assertEnabled();
    const revoked = await runnerDeviceRepository.revoke(userId, deviceId);

    if (revoked) {
      // The token row is already gone, so the device can never reconnect. This tells it to stop NOW.
      await notifyRunnerRevoked(userId, deviceId);
      await auditWriter.write({
        userId,
        action: 'disconnect',
        resourceType: 'system',
        resourceId: deviceId,
        summary: 'You revoked a Stewra Runner device.',
        success: true,
        metadata: { deviceId },
      });
    }
    return revoked;
  }
}

export const runnerService = new RunnerService();
