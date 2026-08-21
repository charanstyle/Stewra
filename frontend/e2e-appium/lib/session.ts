// Opening and closing an Appium session against one real device.
//
// One session per test file per device. Sessions are expensive (WebDriverAgent has to be running
// on iOS, the uiautomator2 server on Android), so tests share one within a file rather than
// standing a fresh one up per `it`.
import { remote } from 'webdriverio';
import type { Device, Platform } from './devices.ts';

/** The app under test. Matches `expo.android.package` / `expo.ios.bundleIdentifier`. */
export const APP_ID = 'com.stewra.app';

/** Where the Appium server listens. `npm run appium` starts it on this port. */
export const APPIUM_PORT = Number(process.env.APPIUM_PORT ?? 4723);

export type Driver = Awaited<ReturnType<typeof remote>>;

/** XCUITest's "running in foreground" application state. */
const APP_STATE_FOREGROUND = 4;

/** The app a uiautomator2 `mobile:` command acts on. */
export interface AndroidAppTarget {
  appId: string;
}

/** The app an XCUITest `mobile:` command acts on. */
export interface IosAppTarget {
  bundleId: string;
}

/** Arguments to `mobile: changePermissions`. */
export interface PermissionChange {
  appPackage: string;
  action: 'grant' | 'revoke';
  permissions: 'all';
}

export type MobileCommandArgs = AndroidAppTarget | IosAppTarget | PermissionChange;

/**
 * Run an Appium `mobile:` extension command.
 *
 * Goes through `executeScript` rather than `execute`: WebdriverIO types `execute` for JavaScript
 * functions, so every `mobile:` call through it infers a nonsense return type (an `Element`) and
 * any comparison against the result fails to typecheck. `executeScript` is the string-command
 * overload and returns `unknown`, which is the honest type — callers narrow it themselves.
 */
export async function mobile(
  driver: Driver,
  command: string,
  args?: MobileCommandArgs,
): Promise<unknown> {
  return driver.executeScript(command, args === undefined ? [] : [args]);
}

/**
 * Get the soft keyboard out of the way on Android, if one is up.
 *
 * Android lays the keyboard over the window rather than insetting it, so a control below the fold
 * — the sign-in button, the composer's Send — is genuinely off-screen and untappable while it is
 * showing. iOS is keyboard-avoiding and needs none of this; worse, its equivalent gesture is a tap
 * outside the keyboard, which lands on whatever is underneath ("Forgot password?" on sign-in, a
 * message bubble in a conversation) and navigates away.
 *
 * The `isKeyboardShown` check is not defensive: `mobile: hideKeyboard` raises when there is no
 * keyboard to hide, and since `typeInto` no longer taps Android fields, not raising one is now the
 * normal case rather than a surprise.
 */
export async function hideKeyboard(driver: Driver, platform: Platform): Promise<void> {
  if (platform !== 'android') return;
  if (!(await driver.isKeyboardShown())) return;
  await mobile(driver, 'mobile: hideKeyboard');
}

/**
 * Capabilities are a discriminated union rather than a loose bag, so a capability that belongs to
 * one driver cannot be handed to the other — the failure mode there is a session that opens fine
 * and then behaves subtly wrong, which is far worse than a type error.
 */
export interface AndroidCapabilities {
  platformName: 'Android';
  'appium:automationName': 'UiAutomator2';
  'appium:udid': string;
  'appium:appPackage': string;
  'appium:appActivity': string;
  'appium:noReset': boolean;
  'appium:newCommandTimeout': number;
  'appium:appWaitForLaunch': boolean;
  'appium:disableWindowAnimation': boolean;
}

export interface IosCapabilities {
  platformName: 'iOS';
  'appium:automationName': 'XCUITest';
  'appium:udid': string;
  'appium:bundleId': string;
  'appium:noReset': boolean;
  'appium:newCommandTimeout': number;
  'appium:usePrebuiltWDA': boolean;
  'appium:showXcodeLog': boolean;
}

export type DeviceCapabilities = AndroidCapabilities | IosCapabilities;

/**
 * Capabilities for one device.
 *
 * `noReset` is on because state is managed explicitly by the tests that need it (see `resetApp`).
 * An implicit reset on every session would reinstall the app and cost minutes across a suite.
 */
export function capabilitiesFor(platform: Platform, udid: string): DeviceCapabilities {
  if (platform === 'android') {
    return {
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:udid': udid,
      'appium:appPackage': APP_ID,
      'appium:appActivity': '.MainActivity',
      'appium:noReset': true,
      'appium:newCommandTimeout': 300,
      // The RN bridge takes a moment on a cold start; without this the first find races the bundle.
      'appium:appWaitForLaunch': true,
      'appium:disableWindowAnimation': true,
    };
  }
  if (platform === 'ios') {
    return {
      platformName: 'iOS',
      'appium:automationName': 'XCUITest',
      'appium:udid': udid,
      'appium:bundleId': APP_ID,
      'appium:noReset': true,
      'appium:newCommandTimeout': 300,
      // Real devices need a signed WebDriverAgent; these let the driver build and install it.
      'appium:usePrebuiltWDA': false,
      'appium:showXcodeLog': false,
    };
  }
  throw new Error(`unknown platform '${platform}' (expected 'android' or 'ios')`);
}

/** Open a session against `device`. Throws if Appium cannot reach it — never returns a stub. */
export async function newSession(device: Device): Promise<Driver> {
  return remote({
    hostname: '127.0.0.1',
    port: APPIUM_PORT,
    path: '/',
    logLevel: 'error',
    connectionRetryTimeout: 240_000,
    connectionRetryCount: 0,
    capabilities: capabilitiesFor(device.platform, device.udid),
  });
}

/**
 * Bring the app under test to the foreground, and prove it got there.
 *
 * Session creation alone is not enough: with `noReset` the driver may attach to whatever is
 * already on screen, and on a shared QA phone that is often a different app entirely. A silent
 * attach to the wrong app fails later as "element not found", which reads like a broken selector
 * rather than a app that was never opened — so assert the package instead of assuming it.
 */
export async function openApp(driver: Driver, platform: Platform): Promise<void> {
  if (platform === 'android') {
    await mobile(driver, 'mobile: activateApp', { appId: APP_ID });
    const active = String(await mobile(driver, 'mobile: getCurrentPackage'));
    if (active !== APP_ID) {
      throw new Error(`expected ${APP_ID} in the foreground after activate, got '${active}'`);
    }
    return;
  }
  await mobile(driver, 'mobile: activateApp', { bundleId: APP_ID });
  const state = Number(await mobile(driver, 'mobile: queryAppState', { bundleId: APP_ID }));
  // XCUITest app states: 4 = running in foreground.
  if (state !== APP_STATE_FOREGROUND) {
    throw new Error(`expected ${APP_ID} running in foreground (state 4), got state ${state}`);
  }
}

/**
 * Wipe app state and relaunch, so a test starts signed out.
 *
 * This is Maestro's `launchApp: clearState: true`, and it keeps the same platform asymmetry that
 * flow documented: Android's `pm clear` really does drop everything, while on iOS the app
 * container is wiped but the **Keychain is not** — `expo-secure-store` keeps the session token
 * there, so the app relaunches already signed in. Callers must treat "already on Chats" as a
 * legitimate start state on iOS and sign out first; see `tests/login.test.ts`.
 */
export async function resetApp(driver: Driver, platform: Platform): Promise<void> {
  if (platform === 'android') {
    await mobile(driver, 'mobile: clearApp', { appId: APP_ID });

    // `pm clear` revokes runtime permissions too, so the next launch re-prompts. Measured: the
    // POST_NOTIFICATIONS dialog (owned by com.google.android.permissioncontroller, not the app)
    // appears *after* sign-in and covers the tab bar — the tabs are rendered, but sit behind a
    // modal window, so `tab-chats` is found and reported not-displayed. The test then fails with
    // "never became visible" against a screen where it is plainly visible.
    //
    // Granted here rather than tapped through: a permission dialog is not the thing under test,
    // and dismissing it would leave the run at the mercy of prompt wording and ordering. This is
    // the state a real signed-in user is in by the time they reach any of these screens.
    await mobile(driver, 'mobile: changePermissions', {
      appPackage: APP_ID,
      action: 'grant',
      permissions: 'all',
    });

    await mobile(driver, 'mobile: activateApp', { appId: APP_ID });
    return;
  }
  await mobile(driver, 'mobile: terminateApp', { bundleId: APP_ID });
  await mobile(driver, 'mobile: activateApp', { bundleId: APP_ID });
}

/** Terminate and relaunch the app, keeping its stored state. */
export async function relaunchApp(driver: Driver, platform: Platform): Promise<void> {
  const target: MobileCommandArgs =
    platform === 'android' ? { appId: APP_ID } : { bundleId: APP_ID };
  await mobile(driver, 'mobile: terminateApp', target);
  await mobile(driver, 'mobile: activateApp', target);
}
