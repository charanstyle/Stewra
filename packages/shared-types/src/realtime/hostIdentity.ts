/**
 * What a machine calls itself — the one thing that lets the server say "this bridge and this runner are the
 * same computer."
 *
 * Until this existed, nothing did. A bridge announced `{ appVersion, waState }` and a runner announced
 * `{ appVersion, os, harnesses, workspaces }`; the only overlap was a free-form display name, and the two
 * derived even that differently (`os.hostname()` on the runner, `$HOSTNAME` on the bridge, which is
 * usually unset on macOS). So a bridge running on the very machine the user was asking about answered "I
 * don't have a machine called that" — correct about its own tenancy, useless to the person holding the
 * phone.
 *
 * THE CONTRACT, and why it is shaped like this. The client does not hash, salt, or normalize. It reports
 * WHICH platform identifier it read and the bytes it read, and the server derives the id it matches on.
 * One implementation of the matching rule, on the server, rather than two that must agree forever across
 * an Electron app and a single-file Node binary that ship on different release cadences. If those two ever
 * read the identifier differently, `kind` differs and the mismatch is VISIBLE, instead of two hashes that
 * quietly never match and a feature that quietly never works.
 *
 * This is a hardware/installation identifier, not a secret and not a credential: it authorizes nothing on
 * its own. It says "same box", and every permission decision that follows is made against the org tables.
 */

/**
 * The identifier read, named by where it came from.
 *
 * Each platform has exactly ONE supported source. There is no second-choice location and no derived
 * substitute: a machine whose identifier cannot be read reports no host identity at all, and Stewra says
 * so, rather than matching on something weaker (a hostname, a MAC address) that would silently pair two
 * unrelated computers.
 *
 * - `darwin-platform-uuid` — `IOPlatformUUID` from `IOPlatformExpertDevice`. Stable across reinstalls.
 * - `linux-machine-id` — `/etc/machine-id`. Stable for the life of the installation.
 *
 * Windows is absent deliberately: neither app ships a Windows build today, and inventing a source we do
 * not run on would be an untested code path pretending to be support.
 */
export const HOST_ID_KINDS = ['darwin-platform-uuid', 'linux-machine-id'] as const;
export type HostIdKind = (typeof HOST_ID_KINDS)[number];

/** `host` on `bridge:hello` and `runner:hello` — who this machine is. */
export interface HostIdentity {
  readonly kind: HostIdKind;
  /** The identifier exactly as read, trimmed and lowercased by the reader. Never hashed by the client. */
  readonly value: string;
  /** `os.hostname()`. For humans only — shown when Stewra has to name a machine it cannot otherwise place. */
  readonly hostname: string;
}
