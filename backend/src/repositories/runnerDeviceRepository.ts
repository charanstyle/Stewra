import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { RunnerDevice, RunnerHarnessInfo, RunnerWorkspace } from '@stewra/shared-types';
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
    harnesses: row.harnesses,
    workspaces: row.workspaces,
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
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
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    // A freshly registered device is not connected yet — it connects its socket next.
    return { device: toModel(row, false), token };
  }

  /**
   * Resolve a raw runner token to its device. A revoked device's row no longer exists, so a revoked token
   * is indistinguishable from a forged one — exactly the behaviour we want, and why revocation deletes.
   */
  async findByToken(token: string): Promise<{ deviceId: string; userId: string } | null> {
    const row = await db
      .selectFrom('runner_devices')
      .select(['id', 'user_id'])
      .where('token_hash', '=', hashToken(token))
      .executeTakeFirst();
    return row === undefined ? null : { deviceId: row.id, userId: row.user_id };
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

  /** Record the runner's reported capabilities and liveness — driven by `runner:hello`. */
  async updateCapabilities(
    deviceId: string,
    params: {
      os: string;
      harnesses: readonly RunnerHarnessInfo[];
      workspaces: readonly RunnerWorkspace[];
    },
  ): Promise<void> {
    await db
      .updateTable('runner_devices')
      .set({
        os: params.os,
        harnesses: JSON.stringify(params.harnesses),
        workspaces: JSON.stringify(params.workspaces),
        last_seen_at: new Date(),
      })
      .where('id', '=', deviceId)
      .execute();
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
