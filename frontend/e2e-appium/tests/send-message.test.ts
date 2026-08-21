// Open a conversation and send a text message.
//
// The Appium port of `../../e2e/flows/send-message.yaml` (plus the `lib/open-thread.yaml` and
// `lib/goto-chats.yaml` preambles it runs). Like `login.test.ts` it runs against every attached
// device, so one invocation covers the whole handset lab.
//
// The assertion is the sent bubble echoing back into the thread: that proves the message reached
// the server and the thread re-rendered from persisted state, not merely that a Send button was
// tappable.
import { describe, it, beforeAll, afterAll, expect, onTestFailed } from 'vitest';
import { captureFailure } from '../lib/diagnostics.ts';
import { allDevices } from '../lib/devices.ts';
import { newSession, type Driver } from '../lib/session.ts';
import { ensureSignedIn, openThread, sendMessage } from '../lib/flows.ts';
import { isTextShowing } from '../lib/selectors.ts';
import { optional, userA } from '../lib/env.ts';
import { MESSAGE_ECHO_TIMEOUT_MS } from '../lib/timeouts.ts';

const devices = await allDevices();
if (devices.length === 0) {
  throw new Error(
    'no devices attached. Android: `adb devices` must list one in state `device`. ' +
      'iOS: `appium driver run xcuitest list-real-devices` must list one — which needs ' +
      '"Connect via network" ticked for the phone in Xcode > Window > Devices and Simulators.',
  );
}

const credentials = userA();

// Which thread to open. Genuinely optional: with no name set the topmost thread is used, which is
// the right target for an account whose conversation list the suite does not control.
const contactName = optional('E2E_CONTACT_NAME');

/**
 * A payload unique to this run and this device.
 *
 * Nonced on purpose. A fixed string ("E2E hello") is satisfied by any of the hundreds of identical
 * bubbles previous runs left in the thread, so the assertion passes without this run having sent
 * anything — which is exactly how the Maestro two-party runner once reported delivery working
 * while device A and device B were exchanging different strings. The device label is included so
 * two phones running concurrently cannot each pass on the other's message.
 */
function noncedMessage(deviceLabel: string): string {
  const slug = deviceLabel.replace(/[^a-zA-Z0-9]+/g, '-');
  return `e2e-${slug}-${Date.now().toString(36)}`;
}

describe.each(devices)('send message on $label', (device) => {
  let driver: Driver;

  beforeAll(async () => {
    driver = await newSession(device);
  }, 300_000);

  afterAll(async () => {
    if (driver) await driver.deleteSession();
  }, 120_000);

  it('sends a message and sees it echoed in the thread', async () => {
    onTestFailed(() => captureFailure(driver, device, 'sends-a-message'));

    await ensureSignedIn(driver, device.platform, credentials);
    await openThread(driver, device.platform, contactName);

    const message = noncedMessage(device.label);
    await sendMessage(driver, device.platform, message);

    // Matched by containment, not equality: on iOS a message bubble is one accessibility element
    // whose label appends the timestamp ("e2e-Pixel-8-mf3k2p, 8:17 AM"), so an exact match fails
    // against a bubble plainly on screen.
    expect(await isTextShowing(driver, device.platform, message, MESSAGE_ECHO_TIMEOUT_MS)).toBe(
      true,
    );
  }, 300_000);
});
