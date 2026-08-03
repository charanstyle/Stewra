import { randomUUID } from 'node:crypto';
import * as Sentry from '@sentry/node';
import type {
  GetHostedRunnerResponse,
  HostedWorkspaceSpec,
  RunnerContainerStatus,
  RunnerDevice,
  RunnerHarnessId,
} from '@stewra/shared-types';
import { config } from '../config/unifiedConfig.js';
import { auditWriter } from '../control-plane/audit/auditWriter.js';
import { runnerDeviceRepository } from '../repositories/runnerDeviceRepository.js';
import type { HostedRunnerRow } from '../repositories/runnerDeviceRepository.js';
import { githubAppService } from './githubAppService.js';
import { ProvisionerError, provisionerClient } from './provisionerClient.js';
import { listOnlineDeviceIds, notifyRunnerRevoked } from '../websocket/runnerEmitter.js';
import { ConflictError, NotFoundError, ServiceUnavailableError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/**
 * The control plane for HOSTED runners — the cloud-first path, where Stewra runs the coding-agent
 * container itself and the user installs nothing.
 *
 * A hosted runner is a `runner_devices` row like any other: same device token, same `/runner` socket
 * namespace, same instant revocation. This service owns only what a laptop has no equivalent of — the
 * container's existence and lifecycle — and it owns that through the provisioner, never through Docker
 * directly. This process has no socket to Docker and must not acquire one.
 *
 * Two properties are worth stating because the rest of the file is built to preserve them:
 *
 * 1. **Nothing half-created survives.** Provisioning writes a database row, creates a container, writes
 *    credentials into it, and starts it — four steps that can each fail. Any failure rolls back BOTH the
 *    container and the row, so the user never ends up owning a runner that cannot work and Stewra never
 *    ends up paying for a container nobody can see. What rollback cannot reach (a provisioner that has
 *    gone unreachable mid-way) is reported loudly and swept by `reconcile`.
 * 2. **The provider secret has one destination.** A `claude setup-token` value transits the provision
 *    request into the container's own volume and stops there. It is never written to the database, never
 *    logged, and cannot be read back through any endpoint — including by the user who supplied it.
 */

/** Container names are the provisioner's own convention (provisioner/src/template.ts) — mirrored, not invented. */
function containerNameFor(deviceId: string): string {
  return `stewra-runner-${deviceId}`;
}

/**
 * Docker's container states, mapped to what Stewra shows a user.
 *
 * The mapping is deliberately lossy in one direction only: anything that is not clearly running or
 * clearly stopped becomes 'failed' rather than being guessed at. A container in `dead` or an unknown
 * future state is not "probably fine" — it is something an operator should see.
 */
function toContainerStatus(dockerStatus: string): RunnerContainerStatus {
  switch (dockerStatus) {
    case 'running':
      return 'running';
    case 'restarting':
      return 'starting';
    case 'created':
    case 'exited':
    case 'paused':
      return 'stopped';
    default:
      return 'failed';
  }
}

/** Name shown in the device list. Not user-supplied: the user did not name this machine, Stewra made it. */
const HOSTED_DEVICE_NAME = 'Stewra Cloud Runner';

/** How often the wake poll checks whether the container has connected its socket. */
const WAKE_POLL_INTERVAL_MS = 500;

/**
 * For lookups where socket connectivity is beside the point (does a runner exist? which container does
 * this row name?). Named rather than an inline `new Set()` so the call site says "we are not asking",
 * instead of appearing to assert that nothing is online.
 */
const EMPTY_ONLINE: ReadonlySet<string> = new Set<string>();

class HostedRunnerService {
  private assertEnabled(): void {
    if (!config.hostedRunner.enabled) {
      throw new ServiceUnavailableError('This Stewra deploy does not host cloud runners');
    }
  }

  /** Whether this user's hosted runner has a socket connected right now. */
  private async isOnline(userId: string, deviceId: string): Promise<boolean> {
    return (await listOnlineDeviceIds(userId)).has(deviceId);
  }

  /** The user's hosted runner, or a loud 404 — every lifecycle action needs one to act on. */
  private async requireHosted(userId: string): Promise<HostedRunnerRow> {
    const row = await runnerDeviceRepository.findHostedByUser(userId, await listOnlineDeviceIds(userId));
    if (row === null) throw new NotFoundError('You have no cloud runner yet');
    return row;
  }

  /** What the "Cloud Runner" card renders. NOT gated: the card must be able to say "not available here". */
  async getStatus(userId: string): Promise<GetHostedRunnerResponse> {
    if (!config.hostedRunner.enabled) {
      return { enabled: false, runner: null, idleStopMinutes: 0 };
    }
    const row = await runnerDeviceRepository.findHostedByUser(userId, await listOnlineDeviceIds(userId));
    return {
      enabled: true,
      runner: row?.device ?? null,
      idleStopMinutes: config.hostedRunner.idleStopMinutes,
    };
  }

  /**
   * Bring a user's cloud runner into existence: row → container → credentials → start.
   *
   * The device row is written FIRST because its id is what names the container; a container created
   * before the row would be one Stewra could not attribute to anyone. That ordering is also why every
   * failure below rolls the row back — an orphaned row is a runner the user can see and cannot use.
   */
  async provision(
    userId: string,
    credentials: Partial<Record<RunnerHarnessId, string>>,
  ): Promise<RunnerDevice> {
    this.assertEnabled();

    // Whether it is connected is irrelevant to "does one already exist", so the online set is empty.
    if ((await runnerDeviceRepository.findHostedByUser(userId, EMPTY_ONLINE)) !== null) {
      throw new ConflictError('You already have a cloud runner');
    }

    // A runner with no repositories can do nothing, and the failure would surface as an empty workspace
    // list long after provisioning "succeeded". Fail here, where the fix ("connect GitHub") is obvious.
    // `listRepos` itself throws when the App is not installed at all.
    const repos = await githubAppService.listRepos(userId);
    if (repos.length === 0) {
      throw new ConflictError(
        'Your GitHub App installation grants no repositories — add at least one, then set up the cloud runner',
      );
    }

    const deviceId = randomUUID();
    // Only the token is kept: it is returned exactly once, and it is the credential the container will
    // authenticate with. The device model is re-read at the end, by which point the row has moved on.
    const { token } = await runnerDeviceRepository.registerDevice({
      userId,
      id: deviceId,
      name: HOSTED_DEVICE_NAME,
      appVersion: config.runner.latestVersion,
      // The container is Linux and we built it; this is a fact, not a guess about a user's machine.
      os: 'linux',
      kind: 'hosted',
      containerName: containerNameFor(deviceId),
      containerStatus: 'provisioning',
    });

    // Which slots actually received a secret — the audit row says what happened, not what was offered.
    const written: string[] = [];
    try {
      await provisionerClient.createRunner(deviceId, {
        STEWRA_API_URL: config.hostedRunner.apiUrl,
        // The device token as environment rather than a written file: the runner needs it before it has
        // touched its volume, and on Stewra's own host `docker inspect` is root-only — root could read
        // the volume anyway. Documented as an accepted trade in runner/HOSTED.md.
        STEWRA_RUNNER_DEVICE_TOKEN: token,
        STEWRA_RUNNER_DEVICE_NAME: HOSTED_DEVICE_NAME,
        // The runner asks the backend what to clone at every boot, so adding a repository to the GitHub
        // App installation reaches it without a reprovision.
        STEWRA_RUNNER_WORKSPACE_MODE: 'backend',
      });

      for (const [harness, secret] of Object.entries(credentials)) {
        if (secret === undefined || secret.length === 0) continue;
        await provisionerClient.putCredential(deviceId, harness, secret);
        written.push(harness);
      }

      const started = await provisionerClient.startRunner(deviceId);
      await runnerDeviceRepository.setContainerStatus(deviceId, toContainerStatus(started.status), {
        startedAt: new Date(),
      });
    } catch (error) {
      await this.rollbackProvision(deviceId, error);
      throw error;
    }

    await auditWriter.write({
      userId,
      action: 'connect',
      resourceType: 'system',
      resourceId: deviceId,
      summary: 'You set up a Stewra Cloud Runner (Stewra now hosts a container that runs coding agents for you).',
      success: true,
      // The harness NAMES, never the secrets — an audit row records that a login was attached, not what it was.
      metadata: { deviceId, harnessesConfigured: written.join(','), repos: repos.length },
    });
    logger.info('hosted-runner: provisioned', { userId, deviceId, repos: repos.length });

    return (await this.requireHosted(userId)).device;
  }

  /**
   * Undo a provision that failed part-way. Best-effort on the container, unconditional on the row.
   *
   * The row goes even if the container could not be removed, because the row is what keeps the device
   * TOKEN alive — and a container whose token is dead can do nothing at all. The stranded container is
   * then an orphan by definition, which is precisely what `reconcile` looks for. Volumes are NOT removed
   * here: nothing of the user's has reached them yet, and passing that flag on an error path is how a
   * working runner eventually gets wiped by a bug in a branch nobody tests.
   */
  private async rollbackProvision(deviceId: string, cause: unknown): Promise<void> {
    logger.error('hosted-runner: provisioning failed, rolling back', {
      deviceId,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    try {
      await provisionerClient.destroyRunner(deviceId, false);
    } catch (error) {
      if (!(error instanceof ProvisionerError && error.isNotFound)) {
        // The container may still exist and we can no longer address it from here. Loud, then swept.
        Sentry.captureException(error);
        logger.error('hosted-runner: rollback could not remove the container; reconcile will sweep it', {
          deviceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await runnerDeviceRepository.deleteById(deviceId);
  }

  /** Start a stopped cloud runner. Idempotent from the user's side — an already-running one just reports. */
  async start(userId: string): Promise<RunnerDevice> {
    this.assertEnabled();
    const hosted = await this.requireHosted(userId);
    const view = await provisionerClient.startRunner(hosted.device.id);
    await runnerDeviceRepository.setContainerStatus(hosted.device.id, toContainerStatus(view.status), {
      startedAt: new Date(),
    });
    logger.info('hosted-runner: started', { userId, deviceId: hosted.device.id, status: view.status });
    return (await this.requireHosted(userId)).device;
  }

  /**
   * Stop a cloud runner's container. The volumes — the cloned repos and any work on them — are untouched,
   * so this is always recoverable: the next session (or `start`) brings it back with everything in place.
   */
  async stop(userId: string): Promise<RunnerDevice> {
    this.assertEnabled();
    const hosted = await this.requireHosted(userId);
    const view = await provisionerClient.stopRunner(hosted.device.id);
    await runnerDeviceRepository.setContainerStatus(hosted.device.id, toContainerStatus(view.status));
    logger.info('hosted-runner: stopped', { userId, deviceId: hosted.device.id, status: view.status });
    return (await this.requireHosted(userId)).device;
  }

  /**
   * Destroy a cloud runner: the row, the container, and the VOLUMES.
   *
   * This is the one path that deletes the user's cloned repositories and anything uncommitted in them,
   * which is why it is a deliberate user action and never a consequence of an error path. The row is
   * deleted first, so the device token dies before the container does — if the destroy then fails, what
   * is left behind is inert rather than a live runner speaking for an account that no longer owns it.
   */
  async destroy(userId: string): Promise<boolean> {
    this.assertEnabled();
    const hosted = await runnerDeviceRepository.findHostedByUser(userId, EMPTY_ONLINE);
    if (hosted === null) return false;

    await runnerDeviceRepository.deleteById(hosted.device.id);
    await notifyRunnerRevoked(userId, hosted.device.id);
    await this.destroyContainer(hosted.device.id, { removeVolumes: true });

    await auditWriter.write({
      userId,
      action: 'disconnect',
      resourceType: 'system',
      resourceId: hosted.device.id,
      summary: 'You destroyed your Stewra Cloud Runner, including its cloned repositories.',
      success: true,
      metadata: { deviceId: hosted.device.id },
    });
    logger.info('hosted-runner: destroyed', { userId, deviceId: hosted.device.id });
    return true;
  }

  /**
   * Remove the container for a device whose row is ALREADY gone — the tail of both `destroy` and the
   * generic revoke path.
   *
   * A provisioner that cannot be reached here is reported, not thrown: the caller's security-relevant
   * work (killing the token) is already done, and failing their request would suggest otherwise. The
   * stranded container is an orphan the hourly reconcile removes.
   */
  async destroyContainer(deviceId: string, opts: { removeVolumes: boolean }): Promise<void> {
    try {
      await provisionerClient.destroyRunner(deviceId, opts.removeVolumes);
    } catch (error) {
      if (error instanceof ProvisionerError && error.isNotFound) return;
      Sentry.captureException(error);
      logger.error('hosted-runner: could not destroy container; reconcile will sweep it', {
        deviceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Replace one harness's provider login — an expired `claude setup-token`, or a first login on a runner
   * provisioned without one. Same one-way trip as provisioning: into the container's volume, never into
   * Stewra's database, never logged, never readable back.
   */
  async updateProviderCredential(userId: string, harness: RunnerHarnessId, secret: string): Promise<void> {
    this.assertEnabled();
    const hosted = await this.requireHosted(userId);
    await provisionerClient.putCredential(hosted.device.id, harness, secret);

    await auditWriter.write({
      userId,
      // 'connect', not a generic update: what happened is that a provider login was attached to a
      // machine that can run code. That belongs in the same audit vocabulary as linking a data source.
      action: 'connect',
      resourceType: 'system',
      resourceId: hosted.device.id,
      summary: `You updated the ${harness} login on your Stewra Cloud Runner.`,
      success: true,
      metadata: { deviceId: hosted.device.id, harness },
    });
    logger.info('hosted-runner: credential updated', { userId, deviceId: hosted.device.id, harness });
  }

  /**
   * Start a stopped hosted container and wait for it to actually CONNECT, not merely to be running.
   *
   * "Running" is Docker's answer; what a session needs is a runner that has said hello on the socket, and
   * the gap between the two is a node process booting, cloning, and probing its harnesses. Returns false
   * on timeout rather than throwing, so the caller can record an honest `runner_wake_timeout` on the
   * session instead of a generic error.
   */
  async wakeAndAwait(userId: string, deviceId: string): Promise<boolean> {
    if (!config.hostedRunner.enabled) return false;
    if (await this.isOnline(userId, deviceId)) return true;

    try {
      const view = await provisionerClient.startRunner(deviceId);
      await runnerDeviceRepository.setContainerStatus(deviceId, toContainerStatus(view.status), {
        startedAt: new Date(),
      });
    } catch (error) {
      Sentry.captureException(error);
      logger.error('hosted-runner: wake could not start the container', {
        userId,
        deviceId,
        error: error instanceof Error ? error.message : String(error),
      });
      await runnerDeviceRepository.setContainerStatus(deviceId, 'failed');
      return false;
    }

    const deadline = Date.now() + config.hostedRunner.wakeTimeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, WAKE_POLL_INTERVAL_MS));
      if (await this.isOnline(userId, deviceId)) {
        logger.info('hosted-runner: woke and connected', { userId, deviceId });
        return true;
      }
    }
    logger.warn('hosted-runner: wake timed out waiting for the runner to connect', {
      userId,
      deviceId,
      timeoutMs: config.hostedRunner.wakeTimeoutMs,
    });
    return false;
  }

  /** The runner said hello: its container is demonstrably running, whatever the row last recorded. */
  async noteConnected(deviceId: string): Promise<void> {
    await runnerDeviceRepository.setContainerStatus(deviceId, 'running');
  }

  // ── Sweeps (driven by the scheduler) ────────────────────────────────────────────────────────────────

  /**
   * Reconcile Stewra's belief about hosted containers with what Docker actually has.
   *
   * Two kinds of drift, both real: a container the provisioner still runs whose device row is gone (a
   * failed rollback, a revoke that could not reach the provisioner) — destroyed, because its token is
   * dead and it is burning host resources for nobody; and a row whose recorded status no longer matches
   * the container (a host reboot stops everything) — corrected, so the UI stops claiming a runner is
   * running when it is not.
   *
   * A row whose container has vanished entirely is left ALONE apart from being marked 'failed'. Deleting
   * it would silently take the user's volumes out of reach; a visible failed runner is something they
   * can act on.
   */
  async reconcile(): Promise<{ orphansDestroyed: number; statusesCorrected: number }> {
    if (!config.hostedRunner.enabled) return { orphansDestroyed: 0, statusesCorrected: 0 };

    const containers = await provisionerClient.listRunners();
    const rows = await runnerDeviceRepository.listAllHosted();
    const rowById = new Map(rows.map((row) => [row.device.id, row]));
    const containerByDeviceId = new Map(containers.map((c) => [c.deviceId, c]));

    let orphansDestroyed = 0;
    for (const container of containers) {
      if (rowById.has(container.deviceId)) continue;
      logger.warn('hosted-runner: reconcile found an orphaned container', {
        deviceId: container.deviceId,
        containerName: container.containerName,
      });
      // Volumes go with it: the device row is gone, so nothing can ever reach this data again, and
      // leaving it would fill the host with disks no user can see or delete.
      await this.destroyContainer(container.deviceId, { removeVolumes: true });
      orphansDestroyed += 1;
    }

    let statusesCorrected = 0;
    for (const row of rows) {
      const container = containerByDeviceId.get(row.device.id);
      const actual: RunnerContainerStatus =
        container === undefined ? 'failed' : toContainerStatus(container.status);
      if (actual === row.device.containerStatus) continue;
      if (container === undefined) {
        logger.error('hosted-runner: reconcile found a device row with no container', {
          deviceId: row.device.id,
          userId: row.userId,
        });
      }
      await runnerDeviceRepository.setContainerStatus(row.device.id, actual);
      statusesCorrected += 1;
    }

    logger.info('hosted-runner: reconcile complete', {
      containers: containers.length,
      rows: rows.length,
      orphansDestroyed,
      statusesCorrected,
    });
    return { orphansDestroyed, statusesCorrected };
  }

  /**
   * Stop hosted containers that have been idle past the configured window.
   *
   * Idle-stop is a resource decision, never a data one: the volumes are untouched and the next session
   * wakes the container with everything in place. The candidate query excludes any runner with a session
   * still in flight — an agent mid-run is silent on the socket, and "no traffic" must never be read as
   * "nothing happening".
   */
  async idleStop(): Promise<number> {
    if (!config.hostedRunner.enabled || config.hostedRunner.idleStopMinutes === 0) return 0;

    const idleBefore = new Date(Date.now() - config.hostedRunner.idleStopMinutes * 60 * 1000);
    const candidates = await runnerDeviceRepository.listIdleHostedCandidates(idleBefore);

    let stopped = 0;
    for (const candidate of candidates) {
      // A device with a live socket is not idle no matter what the timestamps say — it may be connected
      // and simply between sessions, and the timestamps only record the last hello.
      if (await this.isOnline(candidate.userId, candidate.device.id)) continue;
      try {
        const view = await provisionerClient.stopRunner(candidate.device.id);
        await runnerDeviceRepository.setContainerStatus(candidate.device.id, toContainerStatus(view.status));
        stopped += 1;
        logger.info('hosted-runner: idle-stopped', {
          userId: candidate.userId,
          deviceId: candidate.device.id,
          idleStopMinutes: config.hostedRunner.idleStopMinutes,
        });
      } catch (error) {
        // One unreachable container must not stop the sweep for everyone else.
        Sentry.captureException(error);
        logger.error('hosted-runner: idle-stop failed for one runner', {
          deviceId: candidate.device.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return stopped;
  }

  // ── Runner-facing data ──────────────────────────────────────────────────────────────────────────────

  /**
   * What a hosted runner should have checked out, derived live from the user's GitHub App installation.
   *
   * Live rather than snapshotted at provision time: repositories added to (or removed from) the
   * installation take effect on the runner's next boot, with no reprovision and no stale list to expire.
   */
  async listWorkspaces(userId: string): Promise<HostedWorkspaceSpec[]> {
    this.assertEnabled();
    const repos = await githubAppService.listRepos(userId);
    return repos.map((repo) => ({
      id: repo.fullName,
      name: repo.fullName.split('/')[1] ?? repo.fullName,
      cloneUrl: repo.cloneUrl,
      defaultBranch: repo.defaultBranch,
    }));
  }
}

export const hostedRunnerService = new HostedRunnerService();
