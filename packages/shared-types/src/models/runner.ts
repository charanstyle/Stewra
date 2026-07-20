import type { ISODateString, UUID } from '../common/base';
import type {
  RunnerHarnessId,
  RunnerHarnessInfo,
  RunnerSessionStatus,
  RunnerWorkspace,
} from '../realtime/runner';

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

/**
 * One coding session hosted by a runner — a single agent run on one machine against one workspace.
 *
 * `deviceName`/`workspaceName` are SNAPSHOTS taken when the session started, not live joins: a session must
 * still render in the history after its device has been revoked (and its `runner_devices` row deleted), so
 * the display strings travel with the session rather than being looked up from a row that may be gone.
 */
export interface RunnerSession {
  readonly id: UUID;
  /** The machine this ran on. Not guaranteed to still exist as a device (it may have been revoked). */
  readonly deviceId: UUID;
  readonly deviceName: string;
  readonly harness: RunnerHarnessId;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly status: RunnerSessionStatus;
  /** The user's opening instruction to the agent. */
  readonly prompt: string;
  /** A short final summary once the session ends, when the harness produced one. */
  readonly summary: string | null;
  /** The failure reason when `status` is `failed`. */
  readonly error: string | null;
  /**
   * The isolated branch the session's work lives on (`stewra/run/<id>`), recorded once the runner reports
   * it on finish. Null while the session is still starting/running, or if no worktree was ever cut.
   */
  readonly branch: string | null;
  /** The branch's HEAD SHA after the runner's auto-commit — the reviewable tip of the session's output. */
  readonly headSha: string | null;
  /** The pull request URL, once the user has opened one for this session's branch. Null otherwise. */
  readonly prUrl: string | null;
  /** Whether the session's branch has been pushed to its remote. */
  readonly pushed: boolean;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
  /** When the session reached a terminal state, or null while it is still active. */
  readonly endedAt: ISODateString | null;
}
