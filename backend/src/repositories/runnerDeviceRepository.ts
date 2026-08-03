import { createHash, randomBytes, randomInt } from 'node:crypto';
import type {
  RunnerContainerStatus,
  RunnerDevice,
  RunnerDeviceKind,
  RunnerHarnessInfo,
  RunnerWorkspace,
} from '@stewra/shared-types';
import type { Selectable } from 'kysely';
import { config } from '../config/unifiedConfig.js';
import { db } from '../database/index.js';
import type { RunnerDevicesTable } from '../database/types.js';

/**
 * Prefix so a leaked runner token is greppable and instantly recognisable — in a log, a paste, or a
 * secret scanner. Distinct from the bridge's `stwbr_` so the two credential kinds can't be confused.
 */
const TOKEN_PREFIX = 'stwrn_';

/**
 * Ambiguity-free alphabet for a pairing code (no O/0, I/1, S/5, B/8): the user copies it into a terminal
 * by hand, so a glyph collision is a support ticket, not a theoretical worry. Same rationale as
 * `channelIdentityRepository`.
 */
const CODE_ALPHABET = 'ACDEFGHJKLMNPQRTUVWXYZ2346789';
const CODE_BODY_LENGTH = 8;
const CODE_PREFIX = 'STEWRA-';

/** Opaque random string, not a JWT — revocation must be instant (row deletion), same as bridge tokens. */
function generateToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(config.runner.deviceTokenBytes).toString('base64url')}`;
}

/** SHA-256, hex. Not bcrypt: a 32-byte random token has nothing to slow-guess, and we look it up by equality. */
function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** `STEWRA-XXXXXXXX`, CSPRNG (randomInt, never Math.random). */
function generatePairCode(): string {
  let body = '';
  for (let i = 0; i < CODE_BODY_LENGTH; i += 1) {
    body += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return `${CODE_PREFIX}${body}`;
}

function toModel(row: Selectable<RunnerDevicesTable>, online: boolean): RunnerDevice {
  return {
    id: row.id,
    name: row.name,
    os: row.os,
    appVersion: row.app_version,
    online,
    kind: row.kind,
    containerStatus: row.container_status,
    harnesses: row.harnesses,
    workspaces: row.workspaces,
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * A hosted runner as the control plane needs it: the device model plus the owner, because the sweeps
 * act across users and cannot get the owner from a request.
 */
export interface HostedRunnerRow {
  readonly device: RunnerDevice;
  readonly userId: string;
}

function toHostedRow(row: Selectable<RunnerDevicesTable>, online: boolean): HostedRunnerRow {
  if (row.container_name === null) {
    // The database CHECK constraint makes this unreachable; if it ever fires, a hosted row exists whose
    // container nothing can address — a leak that must be loud, not skipped over.
    throw new Error(`hosted runner device ${row.id} has no container name`);
  }
  return { device: toModel(row, online), userId: row.user_id };
}

/**
 * The runner devices a user has registered, and the single-use codes that authorise a new one.
 *
 * SECURITY: `findByToken` is the one function that turns a runner's raw token into a userId — the
 * `/runner` namespace trusts its answer completely. A row may therefore only ever be created by
 * `registerDevice`, which requires a burned pairing code minted only for an authenticated account owner.
 * There is no other entrance.
 *
 * This repository never imports the socket layer: `online` is not a fact it owns, so its callers (the
 * service) pass in the set of device ids that are actually connected. Keeping that dependency out means
 * the repository stays testable against a plain database with no transport in sight.
 */
class RunnerDeviceRepository {
  /**
   * Register a runner and mint its token. The plaintext token is returned HERE AND NOWHERE ELSE — only
   * its hash is stored. A user who loses it re-pairs; there is no "show me the token again".
   */
  async registerDevice(params: {
    userId: string;
    name: string;
    appVersion: string;
    os: string;
    /**
     * Supplied only by the hosted path, which must know the device id BEFORE the row exists: the id is
     * what names the container, and the row cannot be written without that name (a database CHECK). The
     * pairing path omits it and lets Postgres mint one.
     */
    id?: string;
    /** Omitted for the pairing path — a device is a laptop unless Stewra itself is creating it. */
    kind?: RunnerDeviceKind;
    /** Required exactly when `kind` is 'hosted' (the database enforces the pairing). */
    containerName?: string;
    containerStatus?: RunnerContainerStatus;
  }): Promise<{ device: RunnerDevice; token: string }> {
    const token = generateToken();
    const row = await db
      .insertInto('runner_devices')
      .values({
        user_id: params.userId,
        name: params.name,
        token_hash: hashToken(token),
        app_version: params.appVersion,
        os: params.os,
        ...(params.id !== undefined ? { id: params.id } : {}),
        ...(params.kind !== undefined ? { kind: params.kind } : {}),
        ...(params.containerName !== undefined ? { container_name: params.containerName } : {}),
        ...(params.containerStatus !== undefined ? { container_status: params.containerStatus } : {}),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    // A freshly registered device is not connected yet — it connects its socket next.
    return { device: toModel(row, false), token };
  }

  /**
   * Resolve a raw runner token to its device. A revoked device's row no longer exists, so a revoked token
   * is indistinguishable from a forged one — exactly the behaviour we want, and why revocation deletes.
   *
   * `kind` travels with the answer because the endpoints this authenticates decide on it: a git
   * credential Stewra minted may be handed to a hosted container and to nothing else.
   */
  async findByToken(
    token: string,
  ): Promise<{ deviceId: string; userId: string; kind: RunnerDeviceKind } | null> {
    const row = await db
      .selectFrom('runner_devices')
      .select(['id', 'user_id', 'kind'])
      .where('token_hash', '=', hashToken(token))
      .executeTakeFirst();
    return row === undefined ? null : { deviceId: row.id, userId: row.user_id, kind: row.kind };
  }

  /** The user's runners, newest first, with `online` overlaid from the set of currently-connected ids. */
  async listByUser(userId: string, onlineIds: ReadonlySet<string>): Promise<RunnerDevice[]> {
    const rows = await db
      .selectFrom('runner_devices')
      .selectAll()
      .where('user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map((row) => toModel(row, onlineIds.has(row.id)));
  }

  /**
   * Revoke a runner. Scoped by `user_id` in the WHERE clause rather than checked beforehand, so a caller
   * who passes someone else's device id changes nothing rather than being told it exists.
   */
  async revoke(userId: string, deviceId: string): Promise<boolean> {
    const result = await db
      .deleteFrom('runner_devices')
      .where('id', '=', deviceId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  /**
   * Record the runner's reported capabilities and liveness — driven by `runner:hello`.
   *
   * `app_version` is refreshed here, not only at pairing. A runner that the user upgrades reports its new
   * build on the next hello, and without this the row kept the version it paired with forever — so the
   * panel went on flagging an up-to-date machine as out of date, and the upgrade nudge never stopped.
   */
  async updateCapabilities(
    deviceId: string,
    params: {
      os: string;
      appVersion: string;
      harnesses: readonly RunnerHarnessInfo[];
      workspaces: readonly RunnerWorkspace[];
    },
  ): Promise<void> {
    await db
      .updateTable('runner_devices')
      .set({
        os: params.os,
        app_version: params.appVersion,
        harnesses: JSON.stringify(params.harnesses),
        workspaces: JSON.stringify(params.workspaces),
        last_seen_at: new Date(),
      })
      .where('id', '=', deviceId)
      .execute();
  }

  // ── Hosted runners (migration 037) ──────────────────────────────────────────────────────────────────

  /**
   * The user's ONE hosted runner, or null. The partial unique index is what makes "one" true.
   *
   * `onlineIds` is passed in for the same reason `listByUser` takes it: whether a socket is connected is
   * not a fact this repository owns. The sweeps, which have no socket view, pass an empty set and never
   * read the resulting flag.
   */
  async findHostedByUser(userId: string, onlineIds: ReadonlySet<string>): Promise<HostedRunnerRow | null> {
    const row = await db
      .selectFrom('runner_devices')
      .selectAll()
      .where('user_id', '=', userId)
      .where('kind', '=', 'hosted')
      .executeTakeFirst();
    return row === undefined ? null : toHostedRow(row, onlineIds.has(row.id));
  }

  /** One hosted runner by id, scoped to its owner so a foreign id resolves to nothing rather than to a row. */
  async findHostedById(
    userId: string,
    deviceId: string,
    onlineIds: ReadonlySet<string>,
  ): Promise<HostedRunnerRow | null> {
    const row = await db
      .selectFrom('runner_devices')
      .selectAll()
      .where('id', '=', deviceId)
      .where('user_id', '=', userId)
      .where('kind', '=', 'hosted')
      .executeTakeFirst();
    return row === undefined ? null : toHostedRow(row, onlineIds.has(row.id));
  }

  /**
   * Every hosted runner on this deploy — what reconciliation compares against the provisioner's view of
   * Docker. Deliberately not scoped to a user: a container whose row was deleted belongs to nobody, and
   * that is exactly the case reconciliation exists to catch.
   */
  async listAllHosted(): Promise<HostedRunnerRow[]> {
    const rows = await db
      .selectFrom('runner_devices')
      .selectAll()
      .where('kind', '=', 'hosted')
      .orderBy('created_at', 'asc')
      .execute();
    // `online` is a socket fact this repository does not own; callers that need it overlay it themselves.
    return rows.map((row) => toHostedRow(row, false));
  }

  /**
   * Hosted runners whose container is running, that have been idle past `idleBefore`, and that have NO
   * session still in flight — the idle-stop candidates.
   *
   * "Idle" is measured from the LATEST of the container's start and the device's last hello, so a runner
   * that has been quietly connected all along is still idle, while one that just booted is not. The
   * active-session check is a NOT EXISTS rather than a status test on the device, because a session that
   * is mid-agent-run has no visible traffic and would otherwise be killed under its own agent.
   */
  async listIdleHostedCandidates(idleBefore: Date): Promise<HostedRunnerRow[]> {
    const rows = await db
      .selectFrom('runner_devices')
      .selectAll()
      .where('kind', '=', 'hosted')
      .where('container_status', '=', 'running')
      .where((eb) =>
        eb.and([
          eb.or([
            eb('container_last_started_at', 'is', null),
            eb('container_last_started_at', '<', idleBefore),
          ]),
          eb.or([eb('last_seen_at', 'is', null), eb('last_seen_at', '<', idleBefore)]),
        ]),
      )
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('runner_sessions')
              .select('runner_sessions.id')
              .whereRef('runner_sessions.device_id', '=', 'runner_devices.id')
              .where('runner_sessions.ended_at', 'is', null),
          ),
        ),
      )
      .execute();
    return rows.map((row) => toHostedRow(row, false));
  }

  /**
   * Record what Stewra now believes about a hosted container. `startedAt` is passed only by the paths
   * that actually started it, so a status refresh never invents a start time the container did not have.
   */
  async setContainerStatus(
    deviceId: string,
    status: RunnerContainerStatus,
    opts?: { startedAt?: Date },
  ): Promise<void> {
    await db
      .updateTable('runner_devices')
      .set({
        container_status: status,
        ...(opts?.startedAt !== undefined ? { container_last_started_at: opts.startedAt } : {}),
      })
      .where('id', '=', deviceId)
      .where('kind', '=', 'hosted')
      .execute();
  }

  /**
   * Delete a device row by id alone, for the rollback path where a half-provisioned runner must be undone
   * and there is no user action to scope it to. Every user-facing deletion goes through `revoke`.
   */
  async deleteById(deviceId: string): Promise<void> {
    await db.deleteFrom('runner_devices').where('id', '=', deviceId).execute();
  }

  /**
   * Mint a fresh single-use pairing code, invalidating any earlier unconsumed one so only the most recent
   * code the user was shown can work. Retries on the (astronomically unlikely) collision.
   */
  async mintPairCode(userId: string, ttlMs: number): Promise<{ code: string; expiresAt: Date }> {
    await db
      .deleteFrom('runner_pair_codes')
      .where('user_id', '=', userId)
      .where('consumed_at', 'is', null)
      .execute();

    const expiresAt = new Date(Date.now() + ttlMs);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = generatePairCode();
      try {
        await db
          .insertInto('runner_pair_codes')
          .values({ user_id: userId, code, expires_at: expiresAt })
          .execute();
        return { code, expiresAt };
      } catch {
        // Unique violation on `code` — vanishingly rare; draw again.
      }
    }
    throw new Error('could not mint a unique runner pairing code');
  }

  /**
   * Burn a pairing code and return whose it was. The UPDATE's WHERE clause is the atomic guard: two
   * runners racing on the same code cannot both win, because the second matches zero rows.
   */
  async consumePairCode(code: string): Promise<string | null> {
    const burned = await db
      .updateTable('runner_pair_codes')
      .set({ consumed_at: new Date() })
      .where('code', '=', code)
      .where('consumed_at', 'is', null)
      .where('expires_at', '>', new Date())
      .returning('user_id')
      .executeTakeFirst();
    return burned?.user_id ?? null;
  }
}

export const runnerDeviceRepository = new RunnerDeviceRepository();
