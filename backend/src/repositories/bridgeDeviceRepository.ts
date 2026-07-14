import { createHash, randomBytes } from 'node:crypto';
import type { BridgeDevice, BridgeWaState } from '@stewra/shared-types';
import { config } from '../config/unifiedConfig';
import { db } from '../database/index';
import type { BridgeDevicesTable } from '../database/types';
import type { Selectable } from 'kysely';

/**
 * Prefix so a leaked token is greppable and instantly recognisable for what it is — in a log, a paste,
 * or a secret scanner. A credential you can't identify on sight is one nobody reports.
 */
const TOKEN_PREFIX = 'stwbr_';

/**
 * Bridge tokens are OPAQUE RANDOM STRINGS, not JWTs — and that is a deliberate departure from how every
 * other credential in this codebase works, so it deserves its reason:
 *
 * A JWT's entire selling point is stateless verification — you can trust it without touching the
 * database. We cannot use that property here, because revocation must be INSTANT: the user hitting
 * "Revoke" on a device is the safety valve of this whole feature, and a signed token that stays valid
 * until it expires would make that button a lie. Since every verification must hit the database anyway
 * to check `revoked_at`, the JWT buys nothing and costs us a class of bug (a validly-signed token for a
 * device that no longer exists).
 *
 * So: 32 random bytes, SHA-256 at rest, looked up by hash. The user sees the plaintext exactly once.
 */
function generateToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(config.whatsappPersonal.bridgeTokenBytes).toString('base64url')}`;
}

/** SHA-256, hex. Not bcrypt: there is no low-entropy password here to slow an attacker down against. */
function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function toModel(row: Selectable<BridgeDevicesTable>): BridgeDevice {
  return {
    id: row.id,
    name: row.name,
    waState: row.wa_state,
    consentVersion: row.consent_version,
    consentedAt: row.consented_at.toISOString(),
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * The typed consents, and the devices those consents authorised.
 *
 * SECURITY: `findByToken` is the single function that turns a bridge's raw token into a userId — the
 * `/bridge` namespace trusts its answer completely. A row may therefore only ever be created by
 * `registerDevice`, which requires a burned pairing code, which is only mintable by a user who has
 * already typed the consent sentence. The chain from "typed the words" to "may speak for this user" has
 * no other entrance.
 */
class BridgeDeviceRepository {
  /**
   * Record a typed consent, verbatim. Never updated and never deduped: a second grant is a second row,
   * because re-consenting after a version bump is a real, separate act we want to be able to see.
   */
  async recordConsent(userId: string, version: number, sentence: string): Promise<Date> {
    const row = await db
      .insertInto('bridge_consents')
      .values({ user_id: userId, version, sentence })
      .returning('consented_at')
      .executeTakeFirstOrThrow();
    return row.consented_at;
  }

  /** The version of the user's most recent consent, or null if they have never given one. */
  async latestConsentVersion(userId: string): Promise<number | null> {
    const row = await db
      .selectFrom('bridge_consents')
      .select('version')
      .where('user_id', '=', userId)
      .orderBy('version', 'desc')
      .executeTakeFirst();
    return row?.version ?? null;
  }

  /** The user's most recent consent at `version` exactly, or null. Used to stamp a new device. */
  async findConsent(userId: string, version: number): Promise<Date | null> {
    const row = await db
      .selectFrom('bridge_consents')
      .select('consented_at')
      .where('user_id', '=', userId)
      .where('version', '=', version)
      .orderBy('consented_at', 'desc')
      .executeTakeFirst();
    return row?.consented_at ?? null;
  }

  /**
   * Register a bridge and mint its token. The plaintext token is returned HERE AND NOWHERE ELSE — only
   * its hash is stored, so neither we nor a database thief can reconstruct it. A user who loses it
   * re-pairs; there is no "show me the token again".
   */
  async registerDevice(params: {
    userId: string;
    name: string;
    appVersion: string;
    consentVersion: number;
    consentedAt: Date;
  }): Promise<{ device: BridgeDevice; token: string }> {
    const token = generateToken();
    const row = await db
      .insertInto('bridge_devices')
      .values({
        user_id: params.userId,
        name: params.name,
        token_hash: hashToken(token),
        app_version: params.appVersion,
        wa_state: 'disconnected',
        consent_version: params.consentVersion,
        consented_at: params.consentedAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { device: toModel(row), token };
  }

  /**
   * Resolve a raw bridge token to its device. A revoked device's row no longer exists, so a revoked
   * token is indistinguishable from a forged one — which is precisely the behaviour we want, and is why
   * revocation deletes rather than flags.
   */
  async findByToken(token: string): Promise<{ deviceId: string; userId: string } | null> {
    const row = await db
      .selectFrom('bridge_devices')
      .select(['id', 'user_id'])
      .where('token_hash', '=', hashToken(token))
      .executeTakeFirst();
    return row === undefined ? null : { deviceId: row.id, userId: row.user_id };
  }

  /** The user's devices, newest first — the "Linked devices" list. */
  async listByUser(userId: string): Promise<BridgeDevice[]> {
    const rows = await db
      .selectFrom('bridge_devices')
      .selectAll()
      .where('user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map(toModel);
  }

  /**
   * Revoke a device, and — if it was the user's LAST one — purge the WhatsApp data it existed to carry.
   *
   * Two promises are being kept here, and both are load-bearing:
   *
   *   1. "Revoke kills the credential." The device row is DELETED, so its token hash is gone. There is no
   *      `revoked` flag for a future query to forget to filter on.
   *
   *   2. "Revoke everything and every trace is gone." Once a user has no bridge, nothing can reach their
   *      WhatsApp on their behalf and nothing new can arrive — so keeping their forwarded messages would
   *      be holding third-party message content for no purpose at all. It goes.
   *
   * Deleting only on the LAST device is what makes this safe for someone with a desktop and a laptop:
   * unlinking one machine must not wipe the allowlist and history that the other one still uses. That is
   * also why `whatsapp_chats` is scoped to the user rather than to the device that forwarded it.
   *
   * Both statements run in ONE transaction, so we can never end up having destroyed the credential while
   * leaving the data, or vice versa. The append-only `audit_log` is untouched: the record that this
   * device existed, and that the user revoked it, survives — the content does not.
   *
   * Scoped by `user_id` in the WHERE clause rather than checked beforehand, so a caller who passes
   * someone else's device id changes nothing rather than being told it exists.
   */
  async revoke(userId: string, deviceId: string): Promise<boolean> {
    return db.transaction().execute(async (trx) => {
      const result = await trx
        .deleteFrom('bridge_devices')
        .where('id', '=', deviceId)
        .where('user_id', '=', userId)
        .executeTakeFirst();
      if (Number(result.numDeletedRows) === 0) return false;

      const remaining = await trx
        .selectFrom('bridge_devices')
        .select('id')
        .where('user_id', '=', userId)
        .executeTakeFirst();
      if (remaining !== undefined) return true;

      // Last bridge gone. `whatsapp_messages` and `whatsapp_outbound` cascade from the chats.
      await trx.deleteFrom('whatsapp_chats').where('user_id', '=', userId).execute();
      return true;
    });
  }

  /** Record the bridge's reported WhatsApp state and liveness (driven by `bridge:hello`/`bridge:state`). */
  async markSeen(deviceId: string, waState: BridgeWaState): Promise<void> {
    await db
      .updateTable('bridge_devices')
      .set({ wa_state: waState, last_seen_at: new Date() })
      .where('id', '=', deviceId)
      .execute();
  }
}

export const bridgeDeviceRepository = new BridgeDeviceRepository();
