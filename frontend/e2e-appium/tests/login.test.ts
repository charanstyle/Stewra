// Sign in with the QA credentials and land on the authenticated tab bar.
//
// The Appium port of `../../e2e/flows/login.yaml`. It runs against **every attached device**, so
// one invocation covers all four handsets; the device list is discovered at collection time.
//
// Landing on `tab-chats` is the real assertion: it proves the server issued a token and the user
// is verified, not merely that a screen rendered.
import { describe, it, beforeAll, afterAll, expect, onTestFailed } from 'vitest';
import { captureFailure } from '../lib/diagnostics.ts';
import { allDevices } from '../lib/devices.ts';
import { newSession, relaunchApp, type Driver } from '../lib/session.ts';
import { ensureSignedOut, signIn } from '../lib/flows.ts';
import { isShowing } from '../lib/selectors.ts';
import { userA } from '../lib/env.ts';
import { LOGIN_TIMEOUT_MS, TESTID_TIMEOUT_MS } from '../lib/timeouts.ts';

const devices = await allDevices();
if (devices.length === 0) {
  throw new Error(
    'no devices attached. Android: `adb devices` must list one in state `device`. ' +
      'iOS: `appium driver run xcuitest list-real-devices` must list one — which needs ' +
      '"Connect via network" ticked for the phone in Xcode > Window > Devices and Simulators.',
  );
}

// Credentials are read once, up front. A missing credential must fail the run immediately rather
// than after a device has been driven for a minute.
const credentials = userA();

describe.each(devices)('login on $label', (device) => {
  let driver: Driver;

  beforeAll(async () => {
    driver = await newSession(device);
  }, 300_000);

  afterAll(async () => {
    if (driver) await driver.deleteSession();
  }, 120_000);

  it('signs in and reaches the Chats tab', async () => {
    onTestFailed(() => captureFailure(driver, device, 'signs-in'));

    await ensureSignedOut(driver, device.platform);
    await signIn(driver, device.platform, credentials);

    expect(await isShowing(driver, device.platform, 'tab-chats', TESTID_TIMEOUT_MS)).toBe(true);
  }, 300_000);

  it('stays signed in across a relaunch', async () => {
    onTestFailed(() => captureFailure(driver, device, 'stays-signed-in'));

    // The session token is persisted, so a relaunch must land straight on the tab bar without a
    // second sign-in. This is the regression guard for token storage, and it is the reason the
    // iOS branch of `ensureSignedOut` exists at all.
    await relaunchApp(driver, device.platform);

    expect(await isShowing(driver, device.platform, 'tab-chats', LOGIN_TIMEOUT_MS)).toBe(true);
  }, 180_000);
});
