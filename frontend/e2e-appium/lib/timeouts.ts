// Every wait in the suite, in one place, with the reason each length was chosen.
//
// Named constants rather than numbers inline: a bare `20000` in a test invites someone to nudge it
// upward when a run is flaky, which converts a real regression into a slower green run.

/** A UI element that is already on screen or one render away. */
export const TESTID_TIMEOUT_MS = 20_000;

/**
 * A cold app start. A Release build has to load and evaluate the embedded JS bundle after launch,
 * which takes a second or two — a bare assertion the instant `activateApp` returns fails against a
 * splash screen that is about to render fine.
 */
export const APP_LAUNCH_TIMEOUT_MS = 30_000;

/** Sign-in round trip: credentials to the server, token back, first authed screen rendered. */
export const LOGIN_TIMEOUT_MS = 30_000;

/**
 * How long to look for the authenticated tab bar on an app that is already running and settled.
 *
 * Deliberately shorter than `APP_LAUNCH_TIMEOUT_MS`, and only safe where a cold start is not in
 * play — mid-test, where the question is which screen we are on rather than whether the app has
 * finished booting.
 */
export const SIGNED_IN_PROBE_MS = 10_000;

/**
 * One slice of the "which screen did we land on?" poll after a launch.
 *
 * Short because the poll alternates between two candidate screens and the loop, not the slice,
 * owns the real budget (`APP_LAUNCH_TIMEOUT_MS`). Giving either candidate a long timeout would
 * spend the whole budget on whichever is checked first and never reach the other — which is
 * exactly how a cold start got misreported as a signed-out app.
 */
export const LANDING_POLL_MS = 2_000;

/**
 * A sent message echoing back into the thread as a bubble.
 *
 * This is a server round trip (the composer posts, the thread re-renders from the persisted
 * message), not a local render, so it gets a real network budget rather than `TESTID_TIMEOUT_MS`.
 */
export const MESSAGE_ECHO_TIMEOUT_MS = 15_000;

/**
 * How long to look for an OS credential-manager sheet after a submit.
 *
 * iOS raises "Save Password?" and Android raises Google Password Manager's "Save password"
 * bottom sheet. Neither is guaranteed — both suppress themselves once the credential is stored or
 * "never save" is remembered — so this is a short look, not a wait anything depends on.
 */
export const OS_PROMPT_TIMEOUT_MS = 8_000;
