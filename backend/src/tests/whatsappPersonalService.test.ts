import { WHATSAPP_PERSONAL_CONSENT_SENTENCE } from '@stewra/shared-types';
import { AuthenticationError, ForbiddenError, ServiceUnavailableError, ValidationError } from '../utils/errors';

const MIN_BRIDGE_VERSION = '1.2.0';

// The feature is off by default in every real deploy, so it must be pinned ON here or every test would
// pass for the wrong reason (a 503 is not the same as a rejection).
const whatsappPersonal = {
  enabled: true,
  downloadUrl: 'https://downloads.example.test/stewra-bridge',
  minBridgeVersion: MIN_BRIDGE_VERSION,
  maxSendsPerMinute: 10,
  retentionDays: 30,
  bridgeTokenBytes: 32,
};

jest.mock('../config/unifiedConfig', () => ({
  config: {
    whatsapp: { linkCodeTtlMs: 600000 },
    get whatsappPersonal() {
      return whatsappPersonal;
    },
  },
}));

// The repositories reach Postgres on import; stub them so this exercises the GATE, not the storage.
jest.mock('../repositories/bridgeDeviceRepository', () => ({
  bridgeDeviceRepository: {
    recordConsent: jest.fn(),
    latestConsentVersion: jest.fn(),
    findConsent: jest.fn(),
    registerDevice: jest.fn(),
    findByToken: jest.fn(),
    listByUser: jest.fn(),
    revoke: jest.fn(),
  },
}));
jest.mock('../repositories/channelIdentityRepository', () => ({
  channelIdentityRepository: { createLinkCode: jest.fn(), consumeCode: jest.fn() },
}));
jest.mock('../control-plane/audit/auditWriter', () => ({ auditWriter: { write: jest.fn() } }));

import { auditWriter } from '../control-plane/audit/auditWriter';
import { bridgeDeviceRepository } from '../repositories/bridgeDeviceRepository';
import { channelIdentityRepository } from '../repositories/channelIdentityRepository';
import { whatsappPersonalService } from '../services/whatsappPersonalService';

const devices = bridgeDeviceRepository as jest.Mocked<typeof bridgeDeviceRepository>;
const codes = channelIdentityRepository as jest.Mocked<typeof channelIdentityRepository>;
const audit = auditWriter as jest.Mocked<typeof auditWriter>;

const CONSENTED_AT = new Date('2026-07-14T10:00:00.000Z');
const USER = 'user-1';

beforeEach(() => {
  jest.clearAllMocks();
  whatsappPersonal.enabled = true;
});

/**
 * The chain that authorises a bridge to speak for a user runs: typed sentence → consent row → pairing
 * code → device token. Each link is checked SERVER-SIDE, and these tests exist to make sure no link can
 * be skipped — because the thing on the other end is a user's real WhatsApp account.
 */
describe('grantConsent', () => {
  it('records the consent, verbatim, when the sentence is right', async () => {
    devices.recordConsent.mockResolvedValue(CONSENTED_AT);

    const result = await whatsappPersonalService.grantConsent(USER, WHATSAPP_PERSONAL_CONSENT_SENTENCE);

    expect(result.consentedAt).toBe(CONSENTED_AT.toISOString());
    expect(devices.recordConsent).toHaveBeenCalledWith(USER, 1, WHATSAPP_PERSONAL_CONSENT_SENTENCE);
  });

  it('REFUSES a sentence that was not actually typed — the server never trusts the client', async () => {
    // This is the test that matters. A client can send anything; only these words unlock the feature.
    await expect(whatsappPersonalService.grantConsent(USER, 'yes')).rejects.toThrow(ValidationError);
    expect(devices.recordConsent).not.toHaveBeenCalled();
  });

  it('writes an audit row naming the actual risk the user accepted', async () => {
    devices.recordConsent.mockResolvedValue(CONSENTED_AT);
    await whatsappPersonalService.grantConsent(USER, WHATSAPP_PERSONAL_CONSENT_SENTENCE);

    const event = audit.write.mock.calls[0]?.[0];
    expect(event?.action).toBe('consent');
    expect(event?.summary).toContain('permanently banned');
    expect(event?.metadata).toMatchObject({ consentVersion: 1 });
  });

  it('refuses outright when the experimental channel is switched off for the deploy', async () => {
    whatsappPersonal.enabled = false;
    await expect(
      whatsappPersonalService.grantConsent(USER, WHATSAPP_PERSONAL_CONSENT_SENTENCE),
    ).rejects.toThrow(ServiceUnavailableError);
  });
});

describe('startPairing', () => {
  it('will not mint a pairing code for a user who never consented', async () => {
    devices.findConsent.mockResolvedValue(null);

    await expect(whatsappPersonalService.startPairing(USER)).rejects.toThrow(ForbiddenError);
    expect(codes.createLinkCode).not.toHaveBeenCalled();
  });

  it('mints a code for a consented user, and hands back the config-driven download URL', async () => {
    devices.findConsent.mockResolvedValue(CONSENTED_AT);
    codes.createLinkCode.mockResolvedValue({ code: 'STEWRA-ABC234', expiresAt: CONSENTED_AT });

    const result = await whatsappPersonalService.startPairing(USER);

    expect(result.code).toBe('STEWRA-ABC234');
    // Never a hardcoded URL in a client — the panel renders whatever this deploy is configured with.
    expect(result.downloadUrl).toBe(whatsappPersonal.downloadUrl);
    expect(codes.createLinkCode).toHaveBeenCalledWith('whatsapp_personal', USER, 600000);
  });
});

describe('claimBridgeToken', () => {
  const claim = { code: 'STEWRA-ABC234', deviceName: "Robin's MacBook", appVersion: '1.2.0' };

  it('mints a device token for a valid code, and returns the token exactly once', async () => {
    codes.consumeCode.mockResolvedValue(USER);
    devices.findConsent.mockResolvedValue(CONSENTED_AT);
    devices.registerDevice.mockResolvedValue({
      token: 'stwbr_secret',
      device: {
        id: 'device-1',
        name: "Robin's MacBook",
        waState: 'disconnected',
        consentVersion: 1,
        consentedAt: CONSENTED_AT.toISOString(),
        lastSeenAt: null,
        createdAt: CONSENTED_AT.toISOString(),
      },
    });

    const result = await whatsappPersonalService.claimBridgeToken(claim);

    expect(result.token).toBe('stwbr_secret');
    expect(result.device.id).toBe('device-1');
    expect(codes.consumeCode).toHaveBeenCalledWith('whatsapp_personal', claim.code);
  });

  it('rejects an unknown, expired, or already-used code', async () => {
    codes.consumeCode.mockResolvedValue(null);

    await expect(whatsappPersonalService.claimBridgeToken(claim)).rejects.toThrow(AuthenticationError);
    expect(devices.registerDevice).not.toHaveBeenCalled();
  });

  it('refuses a bridge build older than the minimum, WITHOUT burning the code', async () => {
    // The version check must come first: a rejected user should still be able to update and retry with
    // the code they already have, rather than having spent it on a failed attempt.
    await expect(
      whatsappPersonalService.claimBridgeToken({ ...claim, appVersion: '1.1.9' }),
    ).rejects.toThrow(ForbiddenError);
    expect(codes.consumeCode).not.toHaveBeenCalled();
  });

  it('accepts a bridge build newer than the minimum', async () => {
    codes.consumeCode.mockResolvedValue(USER);
    devices.findConsent.mockResolvedValue(CONSENTED_AT);
    devices.registerDevice.mockResolvedValue({
      token: 'stwbr_secret',
      device: {
        id: 'device-2',
        name: 'Desktop',
        waState: 'disconnected',
        consentVersion: 1,
        consentedAt: CONSENTED_AT.toISOString(),
        lastSeenAt: null,
        createdAt: CONSENTED_AT.toISOString(),
      },
    });

    // 1.10.0 > 1.2.0 numerically, though it sorts BEFORE it as a string — the check must not be lexical.
    await expect(
      whatsappPersonalService.claimBridgeToken({ ...claim, appVersion: '1.10.0' }),
    ).resolves.toMatchObject({ token: 'stwbr_secret' });
  });

  it('re-checks consent at redemption rather than inferring it from the code', async () => {
    // Defence in depth: a code should only exist for a consented user, but the invariant is enforced
    // where it is relied upon, not assumed to have held across a call boundary.
    codes.consumeCode.mockResolvedValue(USER);
    devices.findConsent.mockResolvedValue(null);

    await expect(whatsappPersonalService.claimBridgeToken(claim)).rejects.toThrow(ForbiddenError);
    expect(devices.registerDevice).not.toHaveBeenCalled();
  });
});

describe('revokeDevice', () => {
  it('revokes and audits the disconnect', async () => {
    devices.revoke.mockResolvedValue(true);

    await expect(whatsappPersonalService.revokeDevice(USER, 'device-1')).resolves.toBe(true);
    expect(audit.write.mock.calls[0]?.[0]?.action).toBe('disconnect');
  });

  it('reports false — and writes no audit row — when nothing matched', async () => {
    // A user passing someone else's device id must change nothing and learn nothing.
    devices.revoke.mockResolvedValue(false);

    await expect(whatsappPersonalService.revokeDevice(USER, 'someone-elses')).resolves.toBe(false);
    expect(audit.write).not.toHaveBeenCalled();
  });

  it('refuses when the channel is switched off, rather than silently doing nothing', async () => {
    whatsappPersonal.enabled = false;
    await expect(whatsappPersonalService.revokeDevice(USER, 'device-1')).rejects.toThrow(
      ServiceUnavailableError,
    );
    expect(devices.revoke).not.toHaveBeenCalled();
  });
});

describe('authenticateBridge', () => {
  it('refuses every token when the channel is disabled, even a real one', async () => {
    whatsappPersonal.enabled = false;
    devices.findByToken.mockResolvedValue({ deviceId: 'device-1', userId: USER });

    // The kill switch must actually kill it: a live token from before the flag was turned off must stop
    // working, or "disabled" means nothing.
    await expect(whatsappPersonalService.authenticateBridge('stwbr_secret')).resolves.toBeNull();
    expect(devices.findByToken).not.toHaveBeenCalled();
  });

  it('resolves a live token to its device and user', async () => {
    devices.findByToken.mockResolvedValue({ deviceId: 'device-1', userId: USER });

    await expect(whatsappPersonalService.authenticateBridge('stwbr_secret')).resolves.toEqual({
      deviceId: 'device-1',
      userId: USER,
    });
  });
});

describe('getStatus', () => {
  it('answers even when the channel is disabled, so the panel can say so', async () => {
    whatsappPersonal.enabled = false;
    devices.latestConsentVersion.mockResolvedValue(null);

    const status = await whatsappPersonalService.getStatus(USER);

    expect(status.enabled).toBe(false);
    expect(status.devices).toEqual([]);
    // A 503 here would leave the UI unable to distinguish "off" from "broken".
    expect(devices.listByUser).not.toHaveBeenCalled();
  });

  it('surfaces a STALE consent as a version mismatch rather than as consent', async () => {
    // Someone who agreed to v1 wording has not agreed to v2 wording. The panel must be able to see the
    // difference and re-ask, which is the entire reason the version is stamped.
    devices.latestConsentVersion.mockResolvedValue(0);
    devices.listByUser.mockResolvedValue([]);

    const status = await whatsappPersonalService.getStatus(USER);

    expect(status.consentVersion).toBe(0);
    expect(status.currentConsentVersion).toBe(1);
  });
});
