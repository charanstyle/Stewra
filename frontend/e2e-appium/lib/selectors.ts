// Turning a `testID` into a selector each platform actually matches.
//
// Measured, not assumed (see `scripts/probe-selectors.ts`). React Native emits `testID` as:
//
//   Android — a bare `resource-id` ("tab-chats"). `content-desc` carries the *label* ("Chats")
//             instead, so WebdriverIO's `~foo` accessibility-id shorthand silently matches
//             nothing. It has to be a UiSelector on resourceId.
//   iOS     — the element's `accessibilityIdentifier`, which is exactly what `~foo` matches.
//
// Getting this wrong does not error; it produces "element not found" against an element plainly
// on screen. Hence one helper, used everywhere, rather than selectors written inline per test.
import type { Driver } from './session.ts';
import type { Platform } from './devices.ts';
import { TESTID_TIMEOUT_MS } from './timeouts.ts';

/** WebdriverIO's element handle. Inferred so it tracks the driver's own types. */
export type Element = Awaited<ReturnType<Driver['$']>>;

export function testIdSelector(platform: Platform, testId: string): string {
  if (platform === 'android') {
    return `android=new UiSelector().resourceId("${testId}")`;
  }
  return `~${testId}`;
}

/**
 * Visible text, as a selector.
 *
 * iOS composes accessibility labels: any RN view that is an accessibility element collapses its
 * children into ONE element whose label is every child's text joined with ", " — a chat row reads
 * "QW, QA Web B, unread-probe 5165x3, 1". Android exposes the children separately. So both
 * platforms match on *containment* rather than equality, which is the behaviour the Maestro flows
 * got by wrapping selectors in `.*`.
 */
export function textSelector(platform: Platform, text: string): string {
  if (platform === 'android') {
    // Must cover `content-desc` as well as `text`, and UiSelector cannot express OR — hence XPath.
    //
    // Measured: this app's labels arrive almost entirely as `content-desc` with `text` empty
    // (`logout-btn` is `content-desc="Log out"`, no text at all), because RN renders them inside
    // accessible composite views rather than as bare TextViews. A `textContains` selector matches
    // nothing at all here and fails as "element not found" against text plainly on screen.
    return `//*[contains(@text, "${text}") or contains(@content-desc, "${text}")]`;
  }
  return `-ios predicate string:label CONTAINS "${text}" OR name CONTAINS "${text}" OR value CONTAINS "${text}"`;
}

/** Wait for the element with `testId` to be displayed, and return it. Throws on timeout. */
export async function waitForTestId(
  driver: Driver,
  platform: Platform,
  testId: string,
  timeout: number = TESTID_TIMEOUT_MS,
): Promise<Element> {
  const el = await driver.$(testIdSelector(platform, testId));
  await el.waitForDisplayed({
    timeout,
    timeoutMsg: `testID "${testId}" never became visible within ${timeout}ms`,
  });
  return el;
}

/** Wait for `text` to appear anywhere on screen. Throws on timeout. */
export async function waitForText(
  driver: Driver,
  platform: Platform,
  text: string,
  timeout: number = TESTID_TIMEOUT_MS,
): Promise<Element> {
  const el = await driver.$(textSelector(platform, text));
  await el.waitForDisplayed({
    timeout,
    timeoutMsg: `text "${text}" never became visible within ${timeout}ms`,
  });
  return el;
}

/** Tap the element with `testId`, waiting for it first. */
export async function tapTestId(
  driver: Driver,
  platform: Platform,
  testId: string,
  timeout: number = TESTID_TIMEOUT_MS,
): Promise<void> {
  const el = await waitForTestId(driver, platform, testId, timeout);
  await el.click();
}

/**
 * Type `value` into the field with `testId`.
 *
 * ANDROID DOES NOT GET A PRECEDING TAP, and that is load-bearing. uiautomator2 sets text through
 * the accessibility node, which needs no focus — while a tap raises the soft keyboard, and Android
 * exposes only the visible window content. On a screen whose input sits at the bottom and is not
 * keyboard-avoiding (the conversation composer), the keyboard then covers the very field just
 * tapped, it drops out of the tree, and the `setValue` that follows fails with "element wasn't
 * found" against a field that was there a moment ago. Measured on Pixel 8; see
 * `artifacts/*-sends-a-message.png`, which shows the composer hidden behind the keyboard.
 *
 * iOS keeps the tap: XCUITest types into the element with keyboard focus, so the field has to be
 * focused first, and iOS insets the scroll view for the keyboard rather than covering content.
 */
export async function typeInto(
  driver: Driver,
  platform: Platform,
  testId: string,
  value: string,
): Promise<void> {
  const el = await waitForTestId(driver, platform, testId);
  if (platform === 'ios') {
    await el.click();
  }
  await el.setValue(value);
}

/**
 * Is this element present and displayed *right now*?
 *
 * For branching on genuinely non-deterministic UI — an OS password-manager sheet that appears only
 * the first time, a session that survived `clearState` on iOS. It answers a question about the
 * screen; it is not an error handler, and no caller may use it to paper over a step that failed.
 */
export async function isShowing(
  driver: Driver,
  platform: Platform,
  testId: string,
  timeout: number,
): Promise<boolean> {
  const el = await driver.$(testIdSelector(platform, testId));
  return el.waitForDisplayed({ timeout }).then(
    () => true,
    () => false,
  );
}

/** As `isShowing`, but for visible text. */
export async function isTextShowing(
  driver: Driver,
  platform: Platform,
  text: string,
  timeout: number,
): Promise<boolean> {
  const el = await driver.$(textSelector(platform, text));
  return el.waitForDisplayed({ timeout }).then(
    () => true,
    () => false,
  );
}
