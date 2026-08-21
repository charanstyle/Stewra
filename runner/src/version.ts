/**
 * The single source of the runner's version. Reported in `pair` (server refuses builds below
 * RUNNER_MIN_VERSION), in every `runner:hello` (server compares against RUNNER_LATEST_VERSION and sends
 * the notify-only upgrade nudge), and as ACP clientInfo. Bump it whenever the wire surface changes.
 */
export const VERSION = '0.3.0';
