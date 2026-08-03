/**
 * REST contracts for the Stewra GitHub App connection — how a user grants Stewra's hosted runner access
 * to chosen repositories WITHOUT ever pasting a credential.
 *
 * The flow is GitHub's own: the user clicks through to the App's install page, picks repositories, and
 * GitHub redirects back to Stewra's setup page carrying an `installation_id`. The only thing Stewra
 * stores is that id (plus the account login for display) — never a token. Git credentials for the hosted
 * runner are short-lived installation tokens minted on demand and handed out per-operation, so there is
 * no long-lived user git credential at rest on Stewra.
 */

/** One repository the user's installation grants access to. */
export interface GithubRepoInfo {
  /** `owner/name`, e.g. `robinstyle/stewra`. */
  readonly fullName: string;
  /** HTTPS clone URL — what the hosted runner clones over, with a minted installation token. */
  readonly cloneUrl: string;
  readonly defaultBranch: string;
  readonly private: boolean;
}

/**
 * GET /github-app — everything the setup UI needs: whether the deploy has a GitHub App at all, whether
 * THIS user has installed it, and what that installation reaches.
 */
export interface GetGithubAppStatusResponse {
  /** False when the deploy has no GitHub App registered — the UI hides the whole section. */
  readonly configured: boolean;
  readonly installed: boolean;
  /** The GitHub account/org the App is installed on. Null until installed. */
  readonly accountLogin: string | null;
  /** Where to send the user to install (or edit) the App. Null when not configured. */
  readonly installUrl: string | null;
  /** The repositories the installation grants. Empty until installed. */
  readonly repos: readonly GithubRepoInfo[];
}

/**
 * POST /github-app/installations — called by the setup page GitHub redirected back to, carrying the
 * `installation_id` and `state` query parameters GitHub echoed. The signed `state` is what ties the
 * credential-less callback to the signed-in user who started the flow.
 */
export interface LinkGithubInstallationRequest {
  readonly installationId: number;
  readonly state: string;
}

export interface LinkGithubInstallationResponse {
  readonly accountLogin: string;
  readonly repos: readonly GithubRepoInfo[];
}

/** DELETE /github-app/installations — forget the link (and best-effort uninstall on GitHub's side). */
export interface UnlinkGithubInstallationResponse {
  readonly unlinked: boolean;
}
