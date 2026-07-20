import type { RunnerDevice, RunnerSession } from '../models/runner';
import type { RunnerHarnessId } from '../realtime/runner';
import type { ISODateString } from '../common/base';

/**
 * REST contracts for the Stewra Runner — the process a user installs on their OWN machine (or cloud VM) to
 * run coding agents. These mirror the `whatsapp_personal` bridge contracts (api/channels.ts): the account
 * owner mints a single-use pairing code from an authenticated surface, and the runner — which holds no
 * user session — redeems it for a long-lived, revocable device token.
 *
 * Why a device token and not the user's JWT: handing a code-executing process the user's access token
 * would give it the entire account, when all it needs is permission to run sessions the user starts. The
 * token is a database row (not a JWT) so revocation from the web app is instant.
 */

/**
 * POST /runner/pair — mint a single-use code the user types/pastes into the runner CLI (`stewra-runner
 * pair <code>`). Requires an authenticated, email-verified account owner.
 */
export interface StartRunnerPairingResponse {
  readonly code: string;
  readonly expiresAt: ISODateString;
  /** Where to get the runner. Config-driven — never a hardcoded URL in a client. */
  readonly downloadUrl: string;
}

/**
 * POST /runner/runner-token — redeemed BY THE RUNNER, not the web client. The pairing code is the only
 * credential it holds, and it is burned on redemption. Unauthenticated by design.
 */
export interface ClaimRunnerTokenRequest {
  readonly code: string;
  /** What to call this machine in the user's device list, e.g. "Robin's MacBook". */
  readonly deviceName: string;
  /** The runner's own version, so the server can refuse a build too old to be safe. */
  readonly appVersion: string;
  /** `process.platform`, so the device list can show the OS before the first socket `hello`. */
  readonly os: string;
}

export interface ClaimRunnerTokenResponse {
  /** Returned exactly ONCE. Hashed at rest server-side, so it can never be shown again. */
  readonly token: string;
  readonly device: RunnerDevice;
}

/** GET /runner/devices — the user's runners, newest first, each with live `online` state. */
export interface ListRunnerDevicesResponse {
  readonly devices: readonly RunnerDevice[];
}

/** DELETE /runner/devices/:id — kills that runner's token immediately and stops its sessions. */
export interface RevokeRunnerDeviceResponse {
  readonly revoked: boolean;
}

/** GET /runner — everything the "Runners" panel needs, including whether the feature is on at all. */
export interface GetRunnerStatusResponse {
  readonly enabled: boolean;
  readonly devices: readonly RunnerDevice[];
  readonly downloadUrl: string;
}

// ── Sessions ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * POST /runner/sessions — start a coding session on a CHOSEN device. Unlike a bridge send (any online
 * machine), a runner session names its target: the user picks which machine and which of its workspaces.
 */
export interface StartRunnerSessionRequest {
  readonly deviceId: string;
  readonly harness: RunnerHarnessId;
  readonly workspaceId: string;
  readonly prompt: string;
}

export interface StartRunnerSessionResponse {
  readonly session: RunnerSession;
}

/** POST /runner/sessions/:id/prompt — a follow-up turn in an existing session. */
export interface PromptRunnerSessionRequest {
  readonly text: string;
}

/** POST /runner/sessions/:id/permission — the user's answer to a permission prompt, relayed to the runner. */
export interface DecideRunnerPermissionRequest {
  readonly promptId: string;
  /** The `id` of the chosen option from the permission request. */
  readonly optionId: string;
}

/** Shared ack for prompt / permission / cancel: whether the instruction was accepted for delivery. */
export interface RunnerSessionActionResponse {
  readonly ok: boolean;
}

/** GET /runner/sessions — the user's sessions, newest first. */
export interface ListRunnerSessionsResponse {
  readonly sessions: readonly RunnerSession[];
}
