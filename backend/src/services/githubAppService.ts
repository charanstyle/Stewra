import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import type {
  GetGithubAppStatusResponse,
  GithubRepoInfo,
  LinkGithubInstallationResponse,
} from '@stewra/shared-types';
import * as Sentry from '@sentry/node';
import { config } from '../config/unifiedConfig.js';
import { auditWriter } from '../control-plane/audit/auditWriter.js';
import { githubAppInstallationRepository } from '../repositories/githubAppInstallationRepository.js';
import {
  AuthenticationError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/** The OAuth-style `state` is a short-lived signed token tying the credential-less callback to the user. */
const STATE_TTL = '10m';

/**
 * GitHub App JWTs may live at most 10 minutes; GitHub also rejects an `iat` in the future, so it is
 * backdated a minute against clock drift — both straight from GitHub's App auth docs.
 */
const APP_JWT_BACKDATE_S = 60;
const APP_JWT_TTL_S = 9 * 60;

/**
 * Installation tokens live ~1 hour. A cached one is reused only while it has at least this much life
 * left, so a token handed to a runner can still finish the git operation it was minted for.
 */
const TOKEN_REUSE_MARGIN_MS = 10 * 60 * 1000;

/** Every GitHub response is from an external service — parsed, never trusted. */
const installationSchema = z.object({
  id: z.number().int(),
  account: z.object({ login: z.string().min(1) }),
});

const accessTokenSchema = z.object({
  token: z.string().min(1),
  expires_at: z.string().min(1),
});

const repositoriesPageSchema = z.object({
  total_count: z.number().int().nonnegative(),
  repositories: z.array(
    z.object({
      full_name: z.string().min(1),
      clone_url: z.string().url(),
      default_branch: z.string().min(1),
      private: z.boolean(),
    }),
  ),
});

interface CachedToken {
  readonly token: string;
  readonly expiresAt: number;
}

/**
 * The Stewra GitHub App: click-through repository access for the HOSTED runner.
 *
 * What this service holds and what it refuses to hold is the point. At rest there is ONE row per user —
 * `installation_id` + account login, no credential (see migration 036). Git access happens through
 * installation tokens minted here on demand from the App's private key: short-lived (≤1 h), cached in
 * memory only, handed out per-operation. So the hosted-mode credential invariant — no long-lived user
 * git credential at rest on Stewra — is enforced by this file having nowhere to put one.
 *
 * Uninstalls are detected lazily: GitHub answers 404 for a dead installation at the next token mint,
 * which clears the row and surfaces "reconnect GitHub" — an MVP trade documented in runner/HOSTED.md
 * (the clean fix is an uninstall webhook).
 */
class GithubAppService {
  /** installationId → live token. In-memory only, per process — a restart just re-mints. */
  private readonly tokenCache = new Map<number, CachedToken>();

  private assertConfigured(): void {
    if (!config.githubApp.enabled) {
      throw new ServiceUnavailableError('This deploy has no GitHub App configured');
    }
  }

  /** Where to send the user to install (or later edit) the App, with a state tying the return to them. */
  getInstallUrl(userId: string): string {
    this.assertConfigured();
    const state = jwt.sign({ nonce: randomBytes(16).toString('hex') }, config.auth.jwtSecret, {
      subject: userId,
      expiresIn: STATE_TTL,
    });
    return `https://github.com/apps/${config.githubApp.slug}/installations/new?state=${encodeURIComponent(state)}`;
  }

  /**
   * Link the installation GitHub redirected back with. The signed `state` is the proof that the person
   * completing the callback is the signed-in user who started it — without it, any authenticated user
   * could claim any installation id they guessed.
   */
  async linkInstallation(
    userId: string,
    installationId: number,
    state: string,
  ): Promise<LinkGithubInstallationResponse> {
    this.assertConfigured();

    let stateSubject: string | undefined;
    try {
      const decoded = jwt.verify(state, config.auth.jwtSecret);
      stateSubject = typeof decoded === 'object' ? decoded.sub : undefined;
    } catch {
      throw new AuthenticationError('The GitHub install link has expired — start again from Stewra');
    }
    if (stateSubject !== userId) {
      throw new AuthenticationError('This GitHub install was started by a different user');
    }

    // The id came from a query parameter; the App JWT lookup is what makes it real. A forged or mistyped
    // id dies here, against GitHub, before anything is stored.
    const installation = await this.fetchInstallation(installationId);

    try {
      await githubAppInstallationRepository.upsertForUser(userId, installationId, installation.account.login);
    } catch {
      // The per-user upsert cannot conflict with itself, so a unique violation here is the OTHER index:
      // this installation is already linked to a different Stewra account.
      throw new ConflictError('That GitHub installation is already linked to another Stewra account');
    }

    await auditWriter.write({
      userId,
      action: 'connect',
      resourceType: 'system',
      resourceId: String(installationId),
      summary: `You connected GitHub (${installation.account.login}) so your cloud runner can reach chosen repositories.`,
      success: true,
      metadata: { installationId, accountLogin: installation.account.login },
    });
    logger.info('github-app: installation linked', { userId, installationId });

    const repos = await this.listRepos(userId);
    return { accountLogin: installation.account.login, repos };
  }

  /** Everything the setup UI needs. Deliberately NOT gated: it must be able to say "not configured". */
  async getStatus(userId: string): Promise<GetGithubAppStatusResponse> {
    if (!config.githubApp.enabled) {
      return { configured: false, installed: false, accountLogin: null, installUrl: null, repos: [] };
    }
    const installation = await githubAppInstallationRepository.findByUser(userId);
    if (installation === null) {
      return {
        configured: true,
        installed: false,
        accountLogin: null,
        installUrl: this.getInstallUrl(userId),
        repos: [],
      };
    }
    return {
      configured: true,
      installed: true,
      accountLogin: installation.accountLogin,
      installUrl: this.getInstallUrl(userId),
      repos: await this.listRepos(userId),
    };
  }

  /** The repositories the user's installation grants — the hosted runner's workspaces. */
  async listRepos(userId: string): Promise<GithubRepoInfo[]> {
    const { token } = await this.mintInstallationToken(userId);
    const repos: GithubRepoInfo[] = [];
    // GitHub pages at 100; loop until the reported total is in hand so a >100-repo install is not
    // silently truncated to its first page.
    for (let page = 1; ; page += 1) {
      const response = await this.githubFetch(`/installation/repositories?per_page=100&page=${page}`, {
        token,
      });
      const parsed = repositoriesPageSchema.parse(await response.json());
      for (const repo of parsed.repositories) {
        repos.push({
          fullName: repo.full_name,
          cloneUrl: repo.clone_url,
          defaultBranch: repo.default_branch,
          private: repo.private,
        });
      }
      if (repos.length >= parsed.total_count || parsed.repositories.length === 0) break;
    }
    return repos;
  }

  /**
   * Mint (or reuse) a short-lived installation token for the user's installation — the ONLY git
   * credential hosted mode ever produces. Callers hand it to exactly one operation and let it die.
   */
  async mintInstallationToken(userId: string): Promise<{ token: string; expiresAt: Date }> {
    this.assertConfigured();
    const installation = await githubAppInstallationRepository.findByUser(userId);
    if (installation === null) {
      throw new NotFoundError('GitHub is not connected — install the Stewra GitHub App first');
    }

    const cached = this.tokenCache.get(installation.installationId);
    if (cached !== undefined && cached.expiresAt - Date.now() > TOKEN_REUSE_MARGIN_MS) {
      return { token: cached.token, expiresAt: new Date(cached.expiresAt) };
    }

    const response = await this.githubFetch(
      `/app/installations/${installation.installationId}/access_tokens`,
      { appJwt: true, method: 'POST' },
    );
    if (response.status === 404) {
      // The user uninstalled the App on GitHub's side. Clear the stale link so the UI tells the truth
      // ("reconnect GitHub") instead of erroring forever against a dead installation.
      await githubAppInstallationRepository.deleteByUser(userId);
      this.tokenCache.delete(installation.installationId);
      logger.info('github-app: installation gone on GitHub; link cleared', {
        userId,
        installationId: installation.installationId,
      });
      throw new NotFoundError('The Stewra GitHub App was uninstalled — reconnect GitHub');
    }
    const parsed = accessTokenSchema.parse(await response.json());
    const expiresAt = new Date(parsed.expires_at);
    this.tokenCache.set(installation.installationId, {
      token: parsed.token,
      expiresAt: expiresAt.getTime(),
    });
    return { token: parsed.token, expiresAt };
  }

  /** Drop the link. Best-effort delete of the installation on GitHub's side too. */
  async unlink(userId: string): Promise<void> {
    this.assertConfigured();
    const installation = await githubAppInstallationRepository.findByUser(userId);
    if (installation === null) return;

    try {
      await this.githubFetch(`/app/installations/${installation.installationId}`, {
        appJwt: true,
        method: 'DELETE',
        allow404: true,
      });
    } catch (error) {
      // The row still goes: the user asked Stewra to forget the link, and a GitHub hiccup must not pin
      // it. The installation, if it survives, dies lazily at the next 404. Logged, never silent.
      // Unlinking locally anyway is the right call for the user. But an installation that survives on
      // GitHub is a live grant against their account that our records say is gone — exactly the kind
      // of divergence that must not be discovered months later.
      Sentry.captureException(error, {
        tags: { surface: 'github_app', step: 'delete_installation' },
        extra: { userId, installationId: installation.installationId },
      });
      logger.warn('github-app: could not delete installation on GitHub; unlinking locally anyway', {
        userId,
        installationId: installation.installationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.tokenCache.delete(installation.installationId);
    await githubAppInstallationRepository.deleteByUser(userId);

    await auditWriter.write({
      userId,
      action: 'disconnect',
      resourceType: 'system',
      resourceId: String(installation.installationId),
      summary: 'You disconnected GitHub from Stewra.',
      success: true,
      metadata: { installationId: installation.installationId },
    });
  }

  /** Look an installation up by id with the App's own identity — used to verify a link callback. */
  private async fetchInstallation(installationId: number): Promise<z.infer<typeof installationSchema>> {
    const response = await this.githubFetch(`/app/installations/${installationId}`, { appJwt: true });
    if (response.status === 404) {
      throw new NotFoundError('GitHub does not recognise that installation');
    }
    return installationSchema.parse(await response.json());
  }

  /**
   * One door to GitHub. Auth is either the App JWT (App-scoped endpoints) or an installation token
   * (repo-scoped endpoints); anything but an expected status is a loud, specific error. 404 is returned
   * to callers that declared they can interpret it (a dead installation is information, not noise).
   */
  private async githubFetch(
    path: string,
    opts: { appJwt?: boolean; token?: string; method?: string; allow404?: boolean },
  ): Promise<Response> {
    const authorization = opts.appJwt === true ? `Bearer ${this.appJwt()}` : `Bearer ${opts.token ?? ''}`;
    const response = await fetch(`${config.githubApp.apiBaseUrl}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        authorization,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'stewra-backend',
      },
    });
    if (response.ok || (response.status === 404 && (opts.allow404 === true || opts.appJwt === true))) {
      return response;
    }
    const body = await response.text();
    throw new Error(`GitHub ${opts.method ?? 'GET'} ${path} failed: ${response.status} ${body.slice(0, 300)}`);
  }

  /** A fresh App JWT per call — signing is cheap, and a cached one would just be a second expiry to track. */
  private appJwt(): string {
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign(
      { iat: now - APP_JWT_BACKDATE_S, exp: now + APP_JWT_TTL_S, iss: config.githubApp.appId },
      config.githubApp.privateKeyPem,
      { algorithm: 'RS256' },
    );
  }
}

export const githubAppService = new GithubAppService();
