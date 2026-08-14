import type {
  ClaimRunnerTokenRequest,
  ClaimRunnerTokenResponse,
  GetRunnerStatusResponse,
  ListRunnerDevicesResponse,
  RunnerDeviceKind,
  RunnerHarnessInfo,
  RunnerWorkspace,
  StartRunnerPairingResponse,
} from '@stewra/shared-types';
import * as Sentry from '@sentry/node';
import { config } from '../config/unifiedConfig.js';
import { auditWriter } from '../control-plane/audit/auditWriter.js';
import { runnerDeviceRepository } from '../repositories/runnerDeviceRepository.js';
import { hostedRunnerService } from './hostedRunnerService.js';
import { listOnlineDeviceIds, notifyRunnerRevoked } from '../websocket/runnerEmitter.js';
import { AuthenticationError, ForbiddenError, ServiceUnavailableError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { meetsMinimumVersion } from '@stewra/shared-types';

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
   * Authenticate a raw runner token. The `/runner` namespace's middleware and the REST
   * `requireRunnerDevice` are its callers. Returns null rather than throwing, because the socket layer
   * wants to reject quietly, not 500.
   *
   * `kind` comes back with it because some device-token endpoints are hosted-only: a credential Stewra
   * minted may go to a container Stewra runs, and never to a machine it does not control.
   */
  async authenticateRunner(
    token: string,
  ): Promise<{ deviceId: string; userId: string; kind: RunnerDeviceKind } | null> {
    if (!config.runner.enabled) return null;
    return runnerDeviceRepository.findByToken(token);
  }

  /** Persist a runner's reported capabilities, version, and liveness (driven by `runner:hello`). */
  async recordCapabilities(
    deviceId: string,
    params: {
      os: string;
      appVersion: string;
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
      return {
        enabled,
        devices: [],
        downloadUrl: config.runner.downloadUrl,
        latestVersion: config.runner.latestVersion,
      };
    }
    const onlineIds = await listOnlineDeviceIds(userId);
    const devices = await runnerDeviceRepository.listByUser(userId, onlineIds);
    return {
      enabled,
      devices,
      downloadUrl: config.runner.downloadUrl,
      latestVersion: config.runner.latestVersion,
    };
  }

  /**
   * Revoke a runner. Instant — the reason runner tokens are database rows, not JWTs.
   *
   * For a HOSTED runner, revoking also destroys the container: leaving it alive would mean Stewra keeps
   * paying to run a process the user has disowned. Its volumes go with it, because the device row that
   * was the only way to reach them is gone. The lookup happens BEFORE the delete (the row is what names
   * the container) but the container teardown happens AFTER, so the token — the security-relevant part —
   * dies first and does not wait on Docker.
   */
  async revokeDevice(userId: string, deviceId: string): Promise<boolean> {
    this.assertEnabled();
    // Looked up regardless of whether hosted runners are currently ENABLED. A deploy that switched the
    // feature off still has whatever containers it provisioned while it was on, and skipping the lookup
    // would silently strand one on every revoke — the exact leak this whole path exists to prevent.
    // The online set is empty because whether it is connected does not change what revoking must do.
    const hosted = await runnerDeviceRepository.findHostedById(userId, deviceId, new Set<string>());
    const revoked = await runnerDeviceRepository.revoke(userId, deviceId);

    if (revoked) {
      // The token row is already gone, so the device can never reconnect. This tells it to stop NOW.
      await notifyRunnerRevoked(userId, deviceId);
      if (hosted !== null && config.hostedRunner.enabled) {
        // Best-effort, and deliberately not awaited into a failure: the token is already dead, so a
        // container we could not reach is inert. `hostedRunnerService.reconcile` sweeps it hourly.
        await hostedRunnerService.destroyContainer(deviceId, { removeVolumes: true });
      } else if (hosted !== null) {
        // Nothing here can reach the provisioner, and nothing will sweep it either (the reconcile timer
        // is off with the feature). This is the one case that needs a human, so it says so by name.
        // The comment above says this case "needs a human, so it says so by name" — but it only said so
        // to a log file. No exception exists here, so the message IS the event.
        Sentry.captureMessage(
          'runner: revoked a hosted device while hosted runners are DISABLED; its container must be removed by hand',
          {
            level: 'error',
            tags: { surface: 'runner', step: 'revoke_hosted' },
            extra: { userId, deviceId, containerName: `stewra-runner-${deviceId}` },
          },
        );
        logger.error(
          'runner: revoked a hosted device while hosted runners are DISABLED; its container must be removed by hand',
          { userId, deviceId, containerName: `stewra-runner-${deviceId}` },
        );
      }
      await auditWriter.write({
        userId,
        action: 'disconnect',
        resourceType: 'system',
        resourceId: deviceId,
        summary:
          hosted === null
            ? 'You revoked a Stewra Runner device.'
            : 'You revoked your Stewra Cloud Runner; its container and cloned repositories were destroyed.',
        success: true,
        metadata: { deviceId, kind: hosted === null ? 'local' : 'hosted' },
      });
    }
    return revoked;
  }
}

export const runnerService = new RunnerService();
