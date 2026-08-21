// Reusable journeys shared by several tests — the Appium equivalent of `flows/lib/*.yaml`.
//
// These are steps, not assertions: they get the app into a known state and throw loudly if they
// cannot. Tests own the assertions about what that state means.
import type { Driver } from './session.ts';
import type { Platform } from './devices.ts';
import { hideKeyboard, openApp, relaunchApp, resetApp } from './session.ts';
import type { Credentials } from './env.ts';
import {
  isShowing,
  isTextShowing,
  tapTestId,
  typeInto,
  waitForTestId,
  waitForText,
} from './selectors.ts';
import {
  APP_LAUNCH_TIMEOUT_MS,
  LANDING_POLL_MS,
  LOGIN_TIMEOUT_MS,
  OS_PROMPT_TIMEOUT_MS,
  SIGNED_IN_PROBE_MS,
  TESTID_TIMEOUT_MS,
} from './timeouts.ts';

/**
 * Dismiss the OS credential-manager prompt raised after a successful sign-in, if it appeared.
 *
 * iOS raises a "Save Password?" system alert; Android raises Google Password Manager's bottom
 * sheet, whose button is "Not now" (lowercase n, unlike iOS's "Not Now"). Both belong to another
 * process and both cover the app — left up, every later assertion fails behind a sheet while the
 * sign-in itself actually succeeded, which is exactly how the old two-party call runner failed
 * with a misleading "caller login failed".
 *
 * Conditional because the prompt is genuinely not guaranteed: both platforms suppress it once the
 * credential is stored or "never save" is remembered. Nothing is load-bearing here — the caller's
 * hard assertion on the tab bar is what decides whether the sign-in worked.
 *
 * Suppressing it at the source does not work: on iOS, writing `AutoFillPasswords false` leaves the
 * alert appearing anyway.
 */
async function dismissCredentialPrompt(driver: Driver, platform: Platform): Promise<void> {
  const label = platform === 'ios' ? 'Not Now' : 'Not now';
  if (await isTextShowing(driver, platform, label, OS_PROMPT_TIMEOUT_MS)) {
    const el = await waitForText(driver, platform, label, OS_PROMPT_TIMEOUT_MS);
    await el.click();
  }
}

/**
 * Put the app in a signed-out state showing the sign-in screen.
 *
 * The platform asymmetry `resetApp` documents is absorbed here: on Android `pm clear` really does
 * drop everything and the app comes up signed out, while on iOS the Keychain survives and the app
 * relaunches straight into the tab bar. Both are legitimate; the sign-out branch handles the
 * second. If neither screen arrives, the final wait throws.
 */
export async function ensureSignedOut(driver: Driver, platform: Platform): Promise<void> {
  await resetApp(driver, platform);
  await openApp(driver, platform);

  // Signed-in detection is by the Chats tab's testID, not its label: since Today became the
  // landing screen, "Chats" only appears as a tab-bar label, and iOS composes those into
  // "Chats, tab, 2 of 6" — a whole-string text match never hits it.
  if (await isShowing(driver, platform, 'tab-chats', APP_LAUNCH_TIMEOUT_MS)) {
    await tapTestId(driver, platform, 'logout-btn');
  }

  await waitForText(driver, platform, 'Sign in', APP_LAUNCH_TIMEOUT_MS);
}

/**
 * Sign in with `credentials` and wait for the authenticated tab bar.
 *
 * Assumes the sign-in screen is showing — call `ensureSignedOut` first.
 */
export async function signIn(
  driver: Driver,
  platform: Platform,
  credentials: Credentials,
): Promise<void> {
  await typeInto(driver, platform, 'login-email-input', credentials.email);
  await typeInto(driver, platform, 'login-password-input', credentials.password);

  // The "Sign in" button sits behind the soft keyboard on shorter screens, so a tap would land on
  // a key instead of the button. See `hideKeyboard` for why this is Android-only.
  await hideKeyboard(driver, platform);

  await tapTestId(driver, platform, 'login-submit');
  await dismissCredentialPrompt(driver, platform);

  // Landing on the main tab bar proves the token was issued and the user is verified.
  await waitForTestId(driver, platform, 'tab-chats', LOGIN_TIMEOUT_MS);
}

/**
 * Put the app in a signed-in state, signing in only if the stored session did not survive.
 *
 * The counterpart to `ensureSignedOut`, for tests whose subject is not authentication. Sign-in
 * costs a server round trip and around 50s on Android, so a test that only needs *a* signed-in
 * app should not pay for a wipe-and-sign-in it does not care about.
 *
 * The branch is on a genuinely non-deterministic state — whether an earlier test file left a
 * session behind, and on iOS whether the Keychain survived — not on a step that might have failed.
 *
 * Both candidate screens are polled together rather than one being checked and the other assumed.
 * `openApp` here is frequently a *cold* start (the previous test file's `deleteSession` stopped the
 * app), so a single short look for the tab bar reads a slow launch as "signed out" and then waits
 * out the full budget for a sign-in screen that is never coming. Neither screen arriving inside
 * the launch budget is a real failure and says so, rather than falling through to a sign-in
 * attempt against whatever happens to be on the display.
 */
export async function ensureSignedIn(
  driver: Driver,
  platform: Platform,
  credentials: Credentials,
): Promise<void> {
  await openApp(driver, platform);

  const deadline = Date.now() + APP_LAUNCH_TIMEOUT_MS;
  for (;;) {
    if (await isShowing(driver, platform, 'tab-chats', LANDING_POLL_MS)) return;
    if (await isTextShowing(driver, platform, 'Sign in', LANDING_POLL_MS)) break;
    if (Date.now() >= deadline) {
      throw new Error(
        `app showed neither the Chats tab nor the sign-in screen within ` +
          `${APP_LAUNCH_TIMEOUT_MS}ms of launch`,
      );
    }
  }

  await signIn(driver, platform, credentials);
}

/**
 * Get back to the Chats list from wherever the previous test left off.
 *
 * Every flow that expects the Chats list has to tolerate being chained after one that ended inside
 * a conversation or on the call screen. Relaunching is the platform-independent way back to the
 * navigator root: the Maestro original used a hardware Back press, which works on Android and is a
 * no-op on iOS, so the flow stayed on the conversation screen and the next assertion failed
 * against a perfectly healthy app. Note there is no state wipe here — the session must survive.
 *
 * "At the navigator root" is detected by the Chats tab's testID rather than the text "Chats": the
 * app lands on Today, where "Chats" exists only as a tab-bar label, and iOS composes those into
 * "Chats, tab, 2 of 6".
 */
export async function gotoChats(driver: Driver, platform: Platform): Promise<void> {
  if (!(await isShowing(driver, platform, 'tab-chats', SIGNED_IN_PROBE_MS))) {
    await relaunchApp(driver, platform);
    await waitForTestId(driver, platform, 'tab-chats', APP_LAUNCH_TIMEOUT_MS);
  }
  await tapTestId(driver, platform, 'tab-chats');
}

/**
 * Open one conversation from the Chats list, and prove we landed inside it.
 *
 * `contactName` picks the thread; omitted, the topmost row is opened via `chat-row-0`. Positional
 * rather than by name because the suite cannot know a conversation id up front, and the most
 * recently active thread — where a message just sent or received lands — sorts to the top.
 *
 * The name match is by containment (see `textSelector`), which matters here specifically: on iOS a
 * chat row is a single accessibility element whose label concatenates every child, so it reads
 * "QW, QA Web B, unread-probe 5165x3, 1" and an equality match finds nothing. `$` returns the
 * first match, which pins the topmost row when the account has several threads with one contact.
 *
 * Opening by `chat-row-0` rather than "first element on screen" is also deliberate: on iOS the
 * root application element carries an accessibility label of its own, so a wildcard match selects
 * the whole screen and the tap lands in the middle of it.
 */
export async function openThread(
  driver: Driver,
  platform: Platform,
  contactName?: string,
): Promise<void> {
  await gotoChats(driver, platform);

  if (contactName !== undefined && contactName.length > 0) {
    const row = await waitForText(driver, platform, contactName, TESTID_TIMEOUT_MS);
    await row.click();
  } else {
    await tapTestId(driver, platform, 'chat-row-0');
  }

  // Proves we actually navigated rather than still sitting on the list.
  await waitForTestId(driver, platform, 'conversation-input', TESTID_TIMEOUT_MS);
}

/**
 * Type `text` into the open conversation's composer and send it.
 *
 * Assumes a conversation is open — call `openThread` first. Returns once Send has been tapped;
 * the caller asserts on the echoed bubble, since that is what proves the message actually posted.
 */
export async function sendMessage(
  driver: Driver,
  platform: Platform,
  text: string,
): Promise<void> {
  await typeInto(driver, platform, 'conversation-input', text);

  // The composer sits at the bottom of the screen and, on Android, the keyboard covers it outright
  // rather than pushing it up — the whole composer row, Send included, is off-screen while the
  // keyboard is showing. See `hideKeyboard`.
  await hideKeyboard(driver, platform);

  // Only rendered while the composer has text, so its presence is itself a check that the text
  // landed in the input rather than somewhere else.
  await tapTestId(driver, platform, 'conversation-send');
}

/** Sign out from the authenticated tabs, and wait for the sign-in screen. */
export async function signOut(driver: Driver, platform: Platform): Promise<void> {
  await tapTestId(driver, platform, 'logout-btn', TESTID_TIMEOUT_MS);
  await waitForText(driver, platform, 'Sign in', APP_LAUNCH_TIMEOUT_MS);
}
