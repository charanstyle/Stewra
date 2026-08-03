import { db } from '../database/index.js';

/** One linked GitHub App installation, as the service layer sees it. */
export interface GithubAppInstallation {
  readonly userId: string;
  readonly installationId: number;
  readonly accountLogin: string;
}

/**
 * The user's GitHub App installation — the only GitHub state at rest, and it holds no credential (see
 * migration 036). One row per user; an installation can belong to only one user. Both are UNIQUE
 * indexes, so the truth is enforced by the database, not by this class's discipline.
 */
class GithubAppInstallationRepository {
  async findByUser(userId: string): Promise<GithubAppInstallation | null> {
    const row = await db
      .selectFrom('github_app_installations')
      .select(['user_id', 'installation_id', 'account_login'])
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (row === undefined) return null;
    return {
      userId: row.user_id,
      // Postgres bigint comes back as a string; an installation id fits comfortably in a JS number.
      installationId: Number(row.installation_id),
      accountLogin: row.account_login,
    };
  }

  /**
   * Link an installation to a user. One row per user: re-linking (the user re-ran the install flow,
   * possibly onto a different account) REPLACES the previous row rather than erroring — the newest
   * click-through is the user's current intent.
   */
  async upsertForUser(userId: string, installationId: number, accountLogin: string): Promise<void> {
    await db
      .insertInto('github_app_installations')
      .values({ user_id: userId, installation_id: installationId, account_login: accountLogin })
      .onConflict((oc) =>
        oc.column('user_id').doUpdateSet({ installation_id: installationId, account_login: accountLogin }),
      )
      .execute();
  }

  /** Remove the link. Used by explicit unlink AND by lazy uninstall detection (a 404 at token mint). */
  async deleteByUser(userId: string): Promise<boolean> {
    const result = await db
      .deleteFrom('github_app_installations')
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }
}

export const githubAppInstallationRepository = new GithubAppInstallationRepository();
