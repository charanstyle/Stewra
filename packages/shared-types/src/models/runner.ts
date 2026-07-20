import type { ISODateString, UUID } from '../common/base';
import type { RunnerHarnessInfo, RunnerWorkspace } from '../realtime/runner';

/**
 * One registered Stewra Runner install — a process on the user's OWN machine (a laptop, or a cloud VM they
 * own) that hosts coding agents and runs them against the user's repositories.
 *
 * Modelled on `BridgeDevice` (and on WhatsApp's "Linked devices" screen) for the same reason: the user's
 * ability to SEE every machine that can run code for them and kill any of them instantly is the strongest
 * safety property in the design. The runner's token is never included here — it is shown once, at pairing.
 *
 * `online`, `harnesses`, and `workspaces` are runtime facts reported over the socket (`runner:hello`);
 * `online` in particular is composed at read time from who is actually connected, not a stored flag that
 * could go stale after an unclean disconnect.
 */
export interface RunnerDevice {
  readonly id: UUID;
  /** User-supplied, e.g. "Robin's MacBook". Shown in the device list; never trusted for anything. */
  readonly name: string;
  /** `process.platform` the runner reported (e.g. `darwin`, `linux`) — helps tell machines apart. */
  readonly os: string;
  readonly appVersion: string;
  /** Whether one of this device's sockets is connected right now. Composed at read time, never stored. */
  readonly online: boolean;
  /** The coding harnesses this machine can host, as last reported. Empty until the runner says hello. */
  readonly harnesses: readonly RunnerHarnessInfo[];
  /** The repositories this machine exposes for sessions, as last reported. */
  readonly workspaces: readonly RunnerWorkspace[];
  /** Last `runner:hello`/heartbeat. Null until the runner connects for the first time. */
  readonly lastSeenAt: ISODateString | null;
  readonly createdAt: ISODateString;
}
