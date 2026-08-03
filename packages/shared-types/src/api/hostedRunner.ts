import type { RunnerDevice } from '../models/runner';
import type { RunnerHarnessId } from '../realtime/runner';
import type { ISODateString } from '../common/base';

/**
 * REST contracts for the HOSTED runner — the cloud-first path, where Stewra runs the coding-agent
 * container itself and the user installs nothing.
 *
 * A hosted runner is the same `RunnerDevice` as a paired laptop (same token, same socket namespace, same
 * revocation), so these endpoints add only what a laptop has no equivalent of: bringing a container into
 * existence, starting and stopping it, writing provider logins into it, and destroying it with its disks.
 *
 * Two of these are called by the RUNNER rather than the web client (`RunnerGitCredentialsResponse`,
 * `HostedWorkspacesResponse`) and authenticate with the device token. Both are refused for a local
 * device: they hand out credentials and repository access Stewra minted, which may only ever reach a
 * machine Stewra controls.
 */

/**
 * POST /runner/hosted — bring the user's cloud runner into existence.
 *
 * `credentials` maps a harness to the provider login the user pasted (e.g. the output of
 * `claude setup-token`). Each value transits THIS REQUEST ONCE: it is written into the container's own
 * volume and is never stored in Stewra's database, never logged, and never readable back through any
 * endpoint. Sending no credentials provisions a runner that can clone and run git but has no agent
 * logged in yet — `PUT /runner/hosted/credentials/:harness` fills that in later.
 */
export interface ProvisionHostedRunnerRequest {
  readonly credentials?: Partial<Record<RunnerHarnessId, string>>;
}

/**
 * GET /runner/hosted — the user's cloud runner, or the absence of one.
 *
 * `enabled` is about the DEPLOY, not the user: false means this Stewra instance hosts no runners at all
 * (no provisioner configured), and the UI should offer only the install-it-yourself path.
 */
export interface GetHostedRunnerResponse {
  readonly enabled: boolean;
  /** Null until provisioned. Carries `kind: 'hosted'` and a live `containerStatus`. */
  readonly runner: RunnerDevice | null;
  /**
   * How long a hosted runner sits idle before Stewra stops its container to free the host. Zero means
   * idle-stop is off. Surfaced so the UI can tell the user the truth rather than a guessed number —
   * a stopped runner that wakes on the next session must not read as a fault.
   */
  readonly idleStopMinutes: number;
}

/** POST /runner/hosted, POST /runner/hosted/start, POST /runner/hosted/stop — the refreshed runner. */
export interface HostedRunnerResponse {
  readonly runner: RunnerDevice;
}

/** DELETE /runner/hosted — destroys the container AND its volumes; the work on them is gone for good. */
export interface DestroyHostedRunnerResponse {
  readonly destroyed: boolean;
}

/**
 * PUT /runner/hosted/credentials/:harness — replace one harness's provider login (an expired
 * `claude setup-token`, or a first login on a runner provisioned without one). Same one-way trip as
 * provisioning: into the container's volume, never into Stewra's database.
 */
export interface UpdateHostedRunnerCredentialRequest {
  readonly secret: string;
}

// ── Runner-facing (device-token auth, hosted devices only) ───────────────────────────────────────────

/**
 * POST /runner/git-credentials — called BY a hosted runner, per git operation, through the runner's
 * `git-credential` helper. Returns a freshly minted GitHub App installation token.
 *
 * Short-lived by design (GitHub caps these at an hour): the runner asks again when it needs one, so
 * nothing long-lived is ever written to the container's disk, and revoking the GitHub App installation
 * cuts access at the next request rather than whenever a stored credential happens to expire.
 *
 * 403 for a local device — Stewra never hands a credential it minted to a machine it does not control.
 */
export interface RunnerGitCredentialsResponse {
  /** GitHub's fixed username for installation-token auth. The token is the password. */
  readonly username: 'x-access-token';
  readonly token: string;
  readonly expiresAt: ISODateString;
}

/** One repository a hosted runner should have checked out, derived from the user's App installation. */
export interface HostedWorkspaceSpec {
  /** Stable workspace id the runner reports back in `hello` — the repo's `owner/name`. */
  readonly id: string;
  /** Display name (the repo name without its owner). */
  readonly name: string;
  /** HTTPS clone URL. The runner supplies credentials through its git helper, not through this URL. */
  readonly cloneUrl: string;
  readonly defaultBranch: string;
}

/**
 * GET /runner/hosted/workspaces — called BY a hosted runner at boot to learn what to clone.
 *
 * Fetched rather than baked into the container's environment at provision time, so adding a repository
 * to the GitHub App installation reaches the runner on its next boot instead of requiring a reprovision.
 */
export interface HostedWorkspacesResponse {
  readonly workspaces: readonly HostedWorkspaceSpec[];
}
