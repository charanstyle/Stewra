import { z } from 'zod';
import type { RunnerConfig } from '../config.js';

/**
 * The two REST endpoints a HOSTED runner calls with its device token, and nothing else.
 *
 * Both are refused by the backend for a paired laptop, and that asymmetry is the point: they hand out a
 * credential Stewra minted and the repository list Stewra derived from the user's GitHub App
 * installation. Those may reach a container Stewra runs; they may never reach a machine it does not
 * control. This module is therefore only ever reached from hosted-mode code paths.
 *
 * Kept out of `StewraRunnerClient` because the git credential helper runs as its OWN short-lived process,
 * spawned by git per operation. It must not open a socket, join the `/runner` namespace, or announce
 * capabilities — it answers one question and exits.
 */

/** Responses are parsed, never trusted: this process feeds the result straight into git. */
const gitCredentialsSchema = z.object({
  data: z.object({
    username: z.literal('x-access-token'),
    token: z.string().min(1),
    expiresAt: z.string().min(1),
  }),
});

const workspacesSchema = z.object({
  data: z.object({
    workspaces: z.array(
      z.object({
        id: z.string().min(1).max(256),
        name: z.string().min(1).max(256),
        cloneUrl: z.string().url(),
        defaultBranch: z.string().min(1).max(256),
      }),
    ),
  }),
});

export type HostedGitCredentials = z.infer<typeof gitCredentialsSchema>['data'];
export type HostedWorkspace = z.infer<typeof workspacesSchema>['data']['workspaces'][number];

/** A git operation waits on this, so it gets a tight cap — a hung mint must not wedge a clone forever. */
const REQUEST_TIMEOUT_MS = 15_000;

/** The message the backend sent, when it sent one — so "reconnect GitHub" reaches the user verbatim. */
async function describeFailure(response: Response, fallback: string): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  const message =
    typeof body === 'object' && body !== null && typeof Reflect.get(body, 'message') === 'string'
      ? String(Reflect.get(body, 'message'))
      : fallback;
  return `${message} (HTTP ${response.status})`;
}

async function hostedRequest(
  config: RunnerConfig,
  token: string,
  path: string,
  method: 'GET' | 'POST',
): Promise<unknown> {
  const response = await fetch(`${config.apiBaseUrl}${config.apiPrefix}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(await describeFailure(response, `Stewra refused ${method} ${path}`));
  }
  return response.json();
}

/**
 * Mint a fresh GitHub App installation token for this runner's git operation.
 *
 * Called per operation rather than cached to disk: GitHub caps these at an hour, and asking each time
 * means removing a repository from the App installation cuts access at the next git command instead of
 * whenever a stored copy happens to expire.
 */
export async function fetchGitCredentials(
  config: RunnerConfig,
  token: string,
): Promise<HostedGitCredentials> {
  const parsed = gitCredentialsSchema.safeParse(
    await hostedRequest(config, token, '/runner/git-credentials', 'POST'),
  );
  if (!parsed.success) {
    throw new Error('Stewra returned a git credential this runner did not understand.');
  }
  return parsed.data.data;
}

/**
 * The repositories this hosted runner should have checked out, from the user's GitHub App installation.
 *
 * Fetched at every boot rather than baked into the container's environment at provision time, so adding a
 * repository to the installation reaches the runner on its next start instead of needing a reprovision.
 */
export async function fetchHostedWorkspaces(
  config: RunnerConfig,
  token: string,
): Promise<readonly HostedWorkspace[]> {
  const parsed = workspacesSchema.safeParse(
    await hostedRequest(config, token, '/runner/hosted/workspaces', 'GET'),
  );
  if (!parsed.success) {
    throw new Error('Stewra returned a workspace list this runner did not understand.');
  }
  return parsed.data.data.workspaces;
}
