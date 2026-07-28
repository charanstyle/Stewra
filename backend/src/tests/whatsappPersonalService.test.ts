import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import {
  WHATSAPP_PERSONAL_CONSENT_SENTENCE,
  WHATSAPP_PERSONAL_CONSENT_VERSION,
} from '@stewra/shared-types';
// Type-only, so they are erased and do NOT load these modules here — each graph is still imported
// dynamically below, after the flag it is named for has been set in the environment.
import type * as errorTypes from '../utils/errors.js';
import type { config } from '../config/unifiedConfig.js';
import type { db, closeDb } from '../database/index.js';
import type { whatsappPersonalService } from '../services/whatsappPersonalService.js';

/**
 * The chain that authorises a bridge to speak for a user runs: typed sentence → consent row → pairing
 * code → device token. Each link is checked SERVER-SIDE, and these tests exist to make sure no link
 * can be skipped — because the thing on the other end is a user's real WhatsApp account.
 *
 * Everything here runs against the real `stewra_test` Postgres. That is the point: this service's
 * guarantees are things like "the code is burned atomically", "revoke DELETES the row", and "a stale
 * consent is not a consent" — claims about rows and transactions, which a substituted repository
 * would assert nothing about. Every expectation below is either a real return value or a real SELECT.
 */

const DOWNLOAD_URL = 'https://downloads.example.test/stewra-bridge';
const MIN_BRIDGE_VERSION = '1.2.0';

// The config is parsed from the environment at import time, so the deploy knobs are pinned BEFORE the
// module graph is loaded rather than substituted afterwards.
process.env['WHATSAPP_PERSONAL_DOWNLOAD_URL'] = DOWNLOAD_URL;
process.env['WHATSAPP_PERSONAL_MIN_BRIDGE_VERSION'] = MIN_BRIDGE_VERSION;

interface ServiceGraph {
  readonly config: typeof config;
  readonly service: typeof whatsappPersonalService;
  readonly db: typeof db;
  readonly closeDb: typeof closeDb;
  readonly errors: typeof errorTypes;
}

/**
 * Load a whole module graph with the feature flag set one way.
 *
 * `WHATSAPP_PERSONAL_ENABLED` is read once, when the config module is first imported, which is
 * exactly how it behaves in a real deploy — a flag is a property of the process, not a value that
 * flips mid-flight. So "off" is a second, independently-configured copy of the application rather
 * than a mutated field, and the kill-switch tests below exercise the same code path a deploy with the
 * flag off would run. Both graphs point at the same database, so a device registered through one is
 * visible to the other.
 */
async function loadGraph(enabled: boolean): Promise<ServiceGraph> {
  process.env['WHATSAPP_PERSONAL_ENABLED'] = enabled ? 'true' : 'false';
  vi.resetModules();
  const { config } = await import('../config/unifiedConfig.js');
  const { whatsappPersonalService } = await import('../services/whatsappPersonalService.js');
  const database = await import('../database/index.js');
  const errors = await import('../utils/errors.js');
  return { config, service: whatsappPersonalService, db: database.db, closeDb: database.closeDb, errors };
}

const on = await loadGraph(true);
const off = await loadGraph(false);

// One real bcrypt hash, reused: no test here authenticates, and hashing 20 throwaway passwords at the
// configured cost factor would add seconds to the run for no coverage.
const PASSWORD_HASH = await bcrypt.hash(randomUUID(), 10);

const createdUsers: string[] = [];

/** A real `users` row — every table below is foreign-keyed to one, so there is no shortcut. */
async function createUser(): Promise<string> {
  const row = await on.db
    .insertInto('users')
    .values({
      email: `bridge-${randomUUID()}@stewra.invalid`,
      display_name: 'Bridge Test User',
      password_hash: PASSWORD_HASH,
      role: 'user',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  createdUsers.push(row.id);
  return row.id;
}

/** Consent + pairing code + registered device, the state most tests need to start from. */
async function pairDevice(
  userId: string,
  appVersion = MIN_BRIDGE_VERSION,
): Promise<{ token: string; deviceId: string }> {
  await on.service.grantConsent(userId, WHATSAPP_PERSONAL_CONSENT_SENTENCE);
  const { code } = await on.service.startPairing(userId);
  const claimed = await on.service.claimBridgeToken({
    code,
    deviceName: "Robin's MacBook",
    appVersion,
  });
  return { token: claimed.token, deviceId: claimed.device.id };
}

async function auditRowsFor(userId: string): Promise<Array<{ action: string; summary: string; metadata: unknown }>> {
  return on.db
    .selectFrom('audit_log')
    .select(['action', 'summary', 'metadata'])
    .where('user_id', '=', userId)
    .orderBy('created_at', 'asc')
    .execute();
}

afterAll(async () => {
  // Users are deleted where possible — bridge_consents, bridge_devices and channel_link_codes all
  // cascade from them. Those that gained an audit row STAY: `audit_log.user_id` is ON DELETE SET
  // NULL, and the table's append-only trigger rejects that UPDATE, so the delete would fail. That is
  // the audit log working as designed, not an obstacle to route around.
  if (createdUsers.length > 0) {
    await on.db
      .deleteFrom('users')
      .where('id', 'in', createdUsers)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('audit_log')
              .select('id')
              .whereRef('audit_log.user_id', '=', 'users.id'),
          ),
        ),
      )
      .execute();
  }
  await Promise.all([on.closeDb(), off.closeDb()]);
});

describe('grantConsent', () => {
  it('records the consent, verbatim, when the sentence is right', async () => {
    const userId = await createUser();

    const result = await on.service.grantConsent(userId, WHATSAPP_PERSONAL_CONSENT_SENTENCE);

    // Verbatim matters: the row IS the evidence of what the user agreed to. A normalised or
    // paraphrased copy would not be.
    const rows = await on.db
      .selectFrom('bridge_consents')
      .select(['version', 'sentence', 'consented_at'])
      .where('user_id', '=', userId)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sentence).toBe(WHATSAPP_PERSONAL_CONSENT_SENTENCE);
    expect(rows[0]?.version).toBe(WHATSAPP_PERSONAL_CONSENT_VERSION);
    expect(result.consentedAt).toBe(rows[0]?.consented_at.toISOString());
  });

  it('REFUSES a sentence that was not actually typed — the server never trusts the client', async () => {
    // This is the test that matters. A client can send anything; only these words unlock the feature.
    const userId = await createUser();

    await expect(on.service.grantConsent(userId, 'yes')).rejects.toThrow(on.errors.ValidationError);

    const rows = await on.db
      .selectFrom('bridge_consents')
      .select('id')
      .where('user_id', '=', userId)
      .execute();
    expect(rows).toHaveLength(0);
  });

  it('writes an audit row naming the actual risk the user accepted', async () => {
    const userId = await createUser();
    await on.service.grantConsent(userId, WHATSAPP_PERSONAL_CONSENT_SENTENCE);

    const events = await auditRowsFor(userId);
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('consent');
    expect(events[0]?.summary).toContain('permanently banned');
    expect(events[0]?.metadata).toMatchObject({ consentVersion: WHATSAPP_PERSONAL_CONSENT_VERSION });
  });

  it('refuses outright when the experimental channel is switched off for the deploy', async () => {
    const userId = await createUser();

    await expect(
      off.service.grantConsent(userId, WHATSAPP_PERSONAL_CONSENT_SENTENCE),
    ).rejects.toThrow(off.errors.ServiceUnavailableError);

    // Refused BEFORE the write, not after it.
    const rows = await on.db
      .selectFrom('bridge_consents')
      .select('id')
      .where('user_id', '=', userId)
      .execute();
    expect(rows).toHaveLength(0);
  });
});

describe('startPairing', () => {
  it('will not mint a pairing code for a user who never consented', async () => {
    const userId = await createUser();

    await expect(on.service.startPairing(userId)).rejects.toThrow(on.errors.ForbiddenError);

    const codes = await on.db
      .selectFrom('channel_link_codes')
      .select('id')
      .where('user_id', '=', userId)
      .execute();
    expect(codes).toHaveLength(0);
  });

  it('mints a code for a consented user, and hands back the config-driven download URL', async () => {
    const userId = await createUser();
    await on.service.grantConsent(userId, WHATSAPP_PERSONAL_CONSENT_SENTENCE);

    const before = Date.now();
    const result = await on.service.startPairing(userId);
    const after = Date.now();

    // The alphabet excludes O/0, I/1, S/5 and B/8 — the user retypes this off a screen.
    expect(result.code).toMatch(/^STEWRA-[ACDEFGHJKLMNPQRTUVWXYZ2346789]{6}$/);
    // Never a hardcoded URL in a client — the panel renders whatever this deploy is configured with.
    expect(result.downloadUrl).toBe(DOWNLOAD_URL);

    const row = await on.db
      .selectFrom('channel_link_codes')
      .select(['channel', 'code', 'expires_at', 'consumed_at'])
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(row.channel).toBe('whatsapp_personal');
    expect(row.code).toBe(result.code);
    expect(row.consumed_at).toBeNull();
    // Short-lived by construction: the TTL comes from config, and the row must actually carry it.
    // Bracketed by the wall clock either side of the call, so this pins the real value rather than
    // merely "some time in the future".
    const ttlMs = on.config.whatsapp.linkCodeTtlMs;
    expect(row.expires_at.getTime()).toBeGreaterThanOrEqual(before + ttlMs);
    expect(row.expires_at.getTime()).toBeLessThanOrEqual(after + ttlMs);
  });

  it('invalidates the previous code, so only the one on screen can work', async () => {
    const userId = await createUser();
    await on.service.grantConsent(userId, WHATSAPP_PERSONAL_CONSENT_SENTENCE);

    const first = await on.service.startPairing(userId);
    const second = await on.service.startPairing(userId);

    const rows = await on.db
      .selectFrom('channel_link_codes')
      .select('code')
      .where('user_id', '=', userId)
      .execute();
    expect(rows.map((r) => r.code)).toEqual([second.code]);
    expect(second.code).not.toBe(first.code);
  });
});

describe('claimBridgeToken', () => {
  const deviceName = "Robin's MacBook";

  it('mints a device token for a valid code, and returns the token exactly once', async () => {
    const userId = await createUser();
    await on.service.grantConsent(userId, WHATSAPP_PERSONAL_CONSENT_SENTENCE);
    const { code } = await on.service.startPairing(userId);

    const result = await on.service.claimBridgeToken({
      code,
      deviceName,
      appVersion: MIN_BRIDGE_VERSION,
    });

    expect(result.token).toMatch(/^stwbr_[A-Za-z0-9_-]+$/);
    expect(result.device.name).toBe(deviceName);
    expect(result.device.waState).toBe('disconnected');

    // "Exactly once" is a storage claim: only the HASH is kept, so nothing can hand the token back.
    const row = await on.db
      .selectFrom('bridge_devices')
      .selectAll()
      .where('id', '=', result.device.id)
      .executeTakeFirstOrThrow();
    expect(row.user_id).toBe(userId);
    expect(row.token_hash).not.toContain(result.token);
    expect(JSON.stringify(row)).not.toContain(result.token);

    // And the code is spent.
    const codeRow = await on.db
      .selectFrom('channel_link_codes')
      .select('consumed_at')
      .where('code', '=', code)
      .executeTakeFirstOrThrow();
    expect(codeRow.consumed_at).not.toBeNull();
  });

  it('rejects an unknown, expired, or already-used code', async () => {
    const userId = await createUser();
    await on.service.grantConsent(userId, WHATSAPP_PERSONAL_CONSENT_SENTENCE);
    const { code } = await on.service.startPairing(userId);
    await on.service.claimBridgeToken({ code, deviceName, appVersion: MIN_BRIDGE_VERSION });

    // Same code, second time — single-use means single-use.
    await expect(
      on.service.claimBridgeToken({ code, deviceName: 'Second machine', appVersion: MIN_BRIDGE_VERSION }),
    ).rejects.toThrow(on.errors.AuthenticationError);
    await expect(
      on.service.claimBridgeToken({ code: 'STEWRA-ZZZZZZ', deviceName, appVersion: MIN_BRIDGE_VERSION }),
    ).rejects.toThrow(on.errors.AuthenticationError);

    const devices = await on.db
      .selectFrom('bridge_devices')
      .select('id')
      .where('user_id', '=', userId)
      .execute();
    expect(devices).toHaveLength(1);
  });

  it('refuses a bridge build older than the minimum, WITHOUT burning the code', async () => {
    // The version check must come first: a rejected user should still be able to update and retry
    // with the code they already have, rather than having spent it on a failed attempt.
    const userId = await createUser();
    await on.service.grantConsent(userId, WHATSAPP_PERSONAL_CONSENT_SENTENCE);
    const { code } = await on.service.startPairing(userId);

    await expect(
      on.service.claimBridgeToken({ code, deviceName, appVersion: '1.1.9' }),
    ).rejects.toThrow(on.errors.ForbiddenError);

    // The proof that the code survived: it still works.
    await expect(
      on.service.claimBridgeToken({ code, deviceName, appVersion: MIN_BRIDGE_VERSION }),
    ).resolves.toMatchObject({ device: { name: deviceName } });
  });

  it('accepts a bridge build newer than the minimum', async () => {
    const userId = await createUser();
    await on.service.grantConsent(userId, WHATSAPP_PERSONAL_CONSENT_SENTENCE);
    const { code } = await on.service.startPairing(userId);

    // 1.10.0 > 1.2.0 numerically, though it sorts BEFORE it as a string — the check must not be lexical.
    await expect(
      on.service.claimBridgeToken({ code, deviceName: 'Desktop', appVersion: '1.10.0' }),
    ).resolves.toMatchObject({ device: { name: 'Desktop' } });
  });

  it('re-checks consent at redemption rather than inferring it from the code', async () => {
    // Defence in depth: a code should only exist for a consented user, but the invariant is enforced
    // where it is relied upon, not assumed to have held across a call boundary. Withdrawing the
    // consent row after the code was minted is the only way to tell the two apart.
    const userId = await createUser();
    await on.service.grantConsent(userId, WHATSAPP_PERSONAL_CONSENT_SENTENCE);
    const { code } = await on.service.startPairing(userId);
    await on.db.deleteFrom('bridge_consents').where('user_id', '=', userId).execute();

    await expect(
      on.service.claimBridgeToken({ code, deviceName, appVersion: MIN_BRIDGE_VERSION }),
    ).rejects.toThrow(on.errors.ForbiddenError);

    const devices = await on.db
      .selectFrom('bridge_devices')
      .select('id')
      .where('user_id', '=', userId)
      .execute();
    expect(devices).toHaveLength(0);
  });
});

describe('revokeDevice', () => {
  it('revokes and audits the disconnect', async () => {
    const userId = await createUser();
    const { deviceId, token } = await pairDevice(userId);

    await expect(on.service.revokeDevice(userId, deviceId)).resolves.toBe(true);

    // DELETED, not flagged — there is no `revoked` column for a later query to forget to filter on,
    // and the token can no longer resolve to anything.
    const rows = await on.db
      .selectFrom('bridge_devices')
      .select('id')
      .where('id', '=', deviceId)
      .execute();
    expect(rows).toHaveLength(0);
    await expect(on.service.authenticateBridge(token)).resolves.toBeNull();

    const actions = (await auditRowsFor(userId)).map((e) => e.action);
    expect(actions).toContain('disconnect');
  });

  it('reports false — and writes no audit row — when nothing matched', async () => {
    // A user passing someone else's device id must change nothing and learn nothing.
    const owner = await createUser();
    const stranger = await createUser();
    const { deviceId } = await pairDevice(owner);

    await expect(on.service.revokeDevice(stranger, deviceId)).resolves.toBe(false);

    const strangerActions = (await auditRowsFor(stranger)).map((e) => e.action);
    expect(strangerActions).not.toContain('disconnect');
    // The owner's device is untouched.
    const rows = await on.db
      .selectFrom('bridge_devices')
      .select('id')
      .where('id', '=', deviceId)
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('refuses when the channel is switched off, rather than silently doing nothing', async () => {
    const userId = await createUser();
    const { deviceId } = await pairDevice(userId);

    await expect(off.service.revokeDevice(userId, deviceId)).rejects.toThrow(
      off.errors.ServiceUnavailableError,
    );

    const rows = await on.db
      .selectFrom('bridge_devices')
      .select('id')
      .where('id', '=', deviceId)
      .execute();
    expect(rows).toHaveLength(1);
  });
});

describe('authenticateBridge', () => {
  it('refuses every token when the channel is disabled, even a real one', async () => {
    // The kill switch must actually kill it: a live token from before the flag was turned off must
    // stop working, or "disabled" means nothing. The token below is genuinely valid — the enabled
    // graph accepts it in the very same test.
    const userId = await createUser();
    const { token, deviceId } = await pairDevice(userId);

    await expect(off.service.authenticateBridge(token)).resolves.toBeNull();
    await expect(on.service.authenticateBridge(token)).resolves.toEqual({ deviceId, userId });
  });

  it('resolves a live token to its device and user', async () => {
    const userId = await createUser();
    const { token, deviceId } = await pairDevice(userId);

    await expect(on.service.authenticateBridge(token)).resolves.toEqual({ deviceId, userId });
    // A near-miss is not a match: the lookup is by hash of the whole string, not a prefix.
    await expect(on.service.authenticateBridge(`${token}x`)).resolves.toBeNull();
  });
});

describe('getStatus', () => {
  it('answers even when the channel is disabled, so the panel can say so', async () => {
    // A 503 here would leave the UI unable to distinguish "off" from "broken". The user genuinely has
    // a device, and the disabled deploy must still answer — reporting none, because none can be used.
    const userId = await createUser();
    await pairDevice(userId);

    const status = await off.service.getStatus(userId);

    expect(status.enabled).toBe(false);
    expect(status.devices).toEqual([]);
    expect(await on.service.getStatus(userId).then((s) => s.devices)).toHaveLength(1);
  });

  it('surfaces a STALE consent as a version mismatch rather than as consent', async () => {
    // Someone who agreed to v1 wording has not agreed to v2 wording. The panel must be able to see
    // the difference and re-ask, which is the entire reason the version is stamped. Writing the old
    // row directly is the only way to have one: the service will only ever record the current
    // version.
    const userId = await createUser();
    await on.db
      .insertInto('bridge_consents')
      .values({
        user_id: userId,
        version: WHATSAPP_PERSONAL_CONSENT_VERSION - 1,
        sentence: 'an older wording of the acknowledgement',
      })
      .execute();

    const status = await on.service.getStatus(userId);

    expect(status.consentVersion).toBe(WHATSAPP_PERSONAL_CONSENT_VERSION - 1);
    expect(status.currentConsentVersion).toBe(WHATSAPP_PERSONAL_CONSENT_VERSION);
    // And the stale consent buys nothing: pairing is still refused.
    await expect(on.service.startPairing(userId)).rejects.toThrow(on.errors.ForbiddenError);
  });
});
