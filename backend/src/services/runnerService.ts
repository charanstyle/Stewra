import type {
  ClaimRunnerTokenRequest,
  ClaimRunnerTokenResponse,
  GetRunnerStatusResponse,
  ListRunnerDevicesResponse,
  RunnerDevice,
  RunnerHarnessInfo,
  RunnerWorkspace,
  StartRunnerPairingResponse,
  UpdateRunnerDeviceRequest,
} from '@stewra/shared-types';
import * as Sentry from '@sentry/node';
import { config } from '../config/unifiedConfig.js';
import { auditWriter } from '../control-plane/audit/auditWriter.js';
import { projectRepository } from '../repositories/projectRepository.js';
import { runnerDeviceRepository } from '../repositories/runnerDeviceRepository.js';
import type { RunnerTokenIdentity } from '../repositories/runnerDeviceRepository.js';
import { organizationRepository } from '../tenancy/repositories/organizationRepository.js';
import { hostedRunnerService } from './hostedRunnerService.js';
import { isDeviceOnline, listOnlineDeviceIds, notifyRunnerRevoked } from '../websocket/runnerEmitter.js';
import {
  AuthenticationError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { meetsMinimumVersion } from '@stewra/shared-types';

/** Who is acting, and on which tenant. Both come from middleware, never from a body. */
export interface OrgActor {
  readonly orgId: string;
  readonly userId: string;
}

/**
 * The Stewra Runner surface: a process on a machine the ORGANIZATION uses that hosts coding agents and
 * runs them against the organization's repositories. This service owns the gate, and only the gate — it
 * never spawns an agent or touches a repo (that is the runner's job, on the machine). Its concern is
 * that a runner claiming to speak for an org was authorised by:
 *
 *   1. an admin of that org, while authenticated, minting a single-use pairing code; then
 *   2. that code being redeemed exactly once for a device token the org can revoke at any moment.
 *
 * Every method that reads or changes a device takes the org from the caller's `:orgId` (or, for the
 * legacy `/runner/*` routes, from `organizationService.resolveActingOrg`), never from the device id
 * alone: a device id is a lookup key, and the org is the scope the lookup runs in.
 */
class RunnerService {
  private assertEnabled(): void {
    if (!config.runner.enabled) {
      throw new ServiceUnavailableError('The Stewra Runner feature is not available');
    }
  }

  /** Mint the single-use code the user pastes into `stewra-runner pair <code>`. The code carries the org. */
  async startPairing(actor: OrgActor): Promise<StartRunnerPairingResponse> {
    this.assertEnabled();
    const org = await organizationRepository.findById(actor.orgId);
    if (org === null) throw new NotFoundError('Organization not found');
    const { code, expiresAt } = await runnerDeviceRepository.mintPairCode(
      actor.userId,
      actor.orgId,
      config.runner.pairCodeTtlMs,
    );
    return {
      code,
      expiresAt: expiresAt.toISOString(),
      downloadUrl: config.runner.downloadUrl,
      orgId: org.id,
      orgName: org.name,
    };
  }

  /**
   * Called BY THE RUNNER, holding only a pairing code. Burns the code and mints the device token. Not
   * behind `requireAuth` — the runner has no user session, and shouldn't: the code IS the credential.
   * The machine lands in the org the code was minted for, and never learns an org id exists.
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

    const burned = await runnerDeviceRepository.consumePairCode(req.code);
    if (burned === null) {
      throw new AuthenticationError('That pairing code is invalid, expired, or already used');
    }

    const { device, token } = await runnerDeviceRepository.registerDevice({
      orgId: burned.orgId,
      userId: burned.userId,
      name: req.deviceName.trim().slice(0, 64),
      appVersion: req.appVersion,
      os: req.os.trim().slice(0, 32),
    });

    await auditWriter.write({
      userId: burned.userId,
      action: 'connect',
      resourceType: 'system',
      resourceId: device.id,
      summary: `You linked "${device.name}" as a Stewra Runner (can run coding agents on that machine).`,
      success: true,
      metadata: { orgId: burned.orgId, deviceId: device.id, appVersion: req.appVersion, os: device.os },
    });

    logger.info('runner: device registered', {
      userId: burned.userId,
      orgId: burned.orgId,
      deviceId: device.id,
      appVersion: req.appVersion,
    });
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
  async authenticateRunner(token: string): Promise<RunnerTokenIdentity | null> {
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
    // Every project binding on this device whose checkout is among the reported workspaces was just
    // seen to exist — the fleet page's `ready`/`stale` split rests on this stamp.
    await projectRepository.markVerified(
      deviceId,
      params.workspaces.map((w) => w.id),
    );
  }

  /** The org's runners, with a truthful `online` state composed from who is actually connected. */
  async listDevices(orgId: string): Promise<ListRunnerDevicesResponse> {
    const onlineIds = config.runner.enabled ? await listOnlineDeviceIds(orgId) : new Set<string>();
    const devices = await runnerDeviceRepository.listByOrg(orgId, onlineIds);
    return { devices };
  }

  /** One of the org's devices with live `online`, or a 404 that does not say whether the id exists elsewhere. */
  async requireDevice(orgId: string, deviceId: string): Promise<RunnerDevice> {
    const device = await runnerDeviceRepository.findInOrg(orgId, deviceId, await isDeviceOnline(deviceId));
    if (device === null) throw new NotFoundError('That runner device does not exist');
    return device;
  }

  /** Everything the "Runners" panel renders, including whether the feature exists on this deploy. */
  async getStatus(orgId: string): Promise<GetRunnerStatusResponse> {
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
    const onlineIds = await listOnlineDeviceIds(orgId);
    const devices = await runnerDeviceRepository.listByOrg(orgId, onlineIds);
    return {
      enabled,
      devices,
      downloadUrl: config.runner.downloadUrl,
      latestVersion: config.runner.latestVersion,
    };
  }

  /** Rename a machine, or relabel it development/production. The label gates session starts in the UI. */
  async updateDevice(actor: OrgActor, deviceId: string, patch: UpdateRunnerDeviceRequest): Promise<RunnerDevice> {
    this.assertEnabled();
    const name = patch.name?.trim();
    if (name !== undefined && (name.length === 0 || name.length > 64)) {
      throw new ValidationError('Validation failed', [
        { field: 'name', message: 'A device name is 1–64 characters' },
      ]);
    }
    if (name === undefined && patch.environment === undefined) {
      throw new ValidationError('Validation failed', [{ field: 'name', message: 'Nothing to change' }]);
    }
    const device = await runnerDeviceRepository.updateDevice(
      actor.orgId,
      deviceId,
      {
        ...(name !== undefined ? { name } : {}),
        ...(patch.environment !== undefined ? { environment: patch.environment } : {}),
      },
      await isDeviceOnline(deviceId),
    );
    if (device === null) throw new NotFoundError('That runner device does not exist');

    await auditWriter.write({
      userId: actor.userId,
      action: 'connect',
      resourceType: 'system',
      resourceId: deviceId,
      summary: `You updated the runner "${device.name}" (${device.environment}).`,
      success: true,
      metadata: {
        orgId: actor.orgId,
        deviceId,
        name: device.name,
        environment: device.environment,
      },
    });
    return device;
  }

  /**
   * Move a machine to another organization. Three conditions, each checked, none inferred:
   *   - the caller is an admin of the DESTINATION org (the source is the `:orgId` they already passed
   *     `requireOrgMember('admin')` for);
   *   - the caller is the person who paired the device — it is their machine;
   *   - the device is a local one (hosted runners are per person and are not moved).
   * A move that changes nothing (same org) is a 409, not a silent success.
   */
  async moveDevice(actor: OrgActor, deviceId: string, toOrgId: string): Promise<RunnerDevice> {
    this.assertEnabled();
    if (toOrgId === actor.orgId) {
      throw new ConflictError('That machine is already in this organization.');
    }
    const destination = await organizationRepository.findMembership(actor.userId, toOrgId);
    if (destination === null) throw new NotFoundError('Organization not found');
    if (destination.role !== 'owner' && destination.role !== 'admin') {
      throw new ForbiddenError(
        'You must be an admin of the destination organization to move a machine into it.',
        'INSUFFICIENT_ORG_ROLE',
      );
    }
    const source = await runnerDeviceRepository.findInOrg(actor.orgId, deviceId, false);
    if (source === null) throw new NotFoundError('That runner device does not exist');

    const moved = await runnerDeviceRepository.moveToOrg({
      deviceId,
      fromOrgId: actor.orgId,
      toOrgId,
      pairerUserId: actor.userId,
    });
    if (moved === null) {
      // The device exists in this org (checked above), so the WHERE clause failed on pairer or kind.
      throw new ConflictError(
        source.kind === 'hosted'
          ? 'A cloud runner belongs to the person who set it up and cannot be moved.'
          : 'Only the person who paired this machine can move it.',
      );
    }

    await auditWriter.write({
      userId: actor.userId,
      action: 'connect',
      resourceType: 'system',
      resourceId: deviceId,
      summary: `You moved the runner "${moved.name}" to ${destination.org.name}.`,
      success: true,
      metadata: { fromOrgId: actor.orgId, toOrgId, deviceId },
    });
    logger.info('runner: device moved', { userId: actor.userId, deviceId, fromOrgId: actor.orgId, toOrgId });
    // The socket, if connected, is still in the OLD org's room. Cut it so it reconnects and re-joins
    // under the new tenant; its token is unchanged, so the reconnect succeeds on its own.
    await notifyRunnerRevoked(deviceId);
    return { ...moved, online: false };
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
  async revokeDevice(actor: OrgActor, deviceId: string): Promise<boolean> {
    this.assertEnabled();
    // Looked up regardless of whether hosted runners are currently ENABLED. A deploy that switched the
    // feature off still has whatever containers it provisioned while it was on, and skipping the lookup
    // would silently strand one on every revoke — the exact leak this whole path exists to prevent.
    const existing = await runnerDeviceRepository.findInOrg(actor.orgId, deviceId, false);
    const hosted = existing !== null && existing.kind === 'hosted';
    const revoked = await runnerDeviceRepository.revoke(actor.orgId, deviceId);

    if (revoked) {
      // The token row is already gone, so the device can never reconnect. This tells it to stop NOW.
      await notifyRunnerRevoked(deviceId);
      if (hosted && config.hostedRunner.enabled) {
        // Best-effort, and deliberately not awaited into a failure: the token is already dead, so a
        // container we could not reach is inert. `hostedRunnerService.reconcile` sweeps it hourly.
        await hostedRunnerService.destroyContainer(deviceId, { removeVolumes: true });
      } else if (hosted) {
        // Nothing here can reach the provisioner, and nothing will sweep it either (the reconcile timer
        // is off with the feature). This is the one case that needs a human, so it says so by name —
        // to Sentry, not only to a log file. No exception exists here, so the message IS the event.
        Sentry.captureMessage(
          'runner: revoked a hosted device while hosted runners are DISABLED; its container must be removed by hand',
          {
            level: 'error',
            tags: { surface: 'runner', step: 'revoke_hosted' },
            extra: { userId: actor.userId, deviceId, containerName: `stewra-runner-${deviceId}` },
          },
        );
        logger.error(
          'runner: revoked a hosted device while hosted runners are DISABLED; its container must be removed by hand',
          { userId: actor.userId, deviceId, containerName: `stewra-runner-${deviceId}` },
        );
      }
      await auditWriter.write({
        userId: actor.userId,
        action: 'disconnect',
        resourceType: 'system',
        resourceId: deviceId,
        summary: hosted
          ? 'You revoked your Stewra Cloud Runner; its container and cloned repositories were destroyed.'
          : 'You revoked a Stewra Runner device.',
        success: true,
        metadata: { orgId: actor.orgId, deviceId, kind: hosted ? 'hosted' : 'local' },
      });
    }
    return revoked;
  }
}

export const runnerService = new RunnerService();
