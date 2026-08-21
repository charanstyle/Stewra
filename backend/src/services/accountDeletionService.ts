import * as Sentry from '@sentry/node';
import type {
  AccountDeletionBlocker,
  AccountDeletionPreview,
  AccountDeletionResult,
} from '@stewra/shared-types';
import { db } from '../database/index.js';
import { auditWriter } from '../control-plane/audit/auditWriter.js';
import { vault } from '../control-plane/vault/vault.js';
import { logger } from '../utils/logger.js';
import { ConflictError, NotFoundError } from '../utils/errors.js';
import { userRepository } from '../repositories/userRepository.js';
import { connectionRepository } from '../repositories/connectionRepository.js';
import { purgeConnectionMoneyData } from '../repositories/moneyStore.js';
import { organizationRepository } from '../commerce/repositories/organizationRepository.js';
import { storeSubscriptionRepository } from '../commerce/repositories/storeSubscriptionRepository.js';
import { removeItem } from './plaidService.js';
import { revokeRefreshToken } from './googleOAuthService.js';
import { emailRetentionService } from './emailRetentionService.js';
import { memoryService } from './memoryService.js';
import { processMemoryService } from './processMemoryService.js';
import { mediaService } from './mediaService.js';
import { presenceService } from './presenceService.js';
import { hostedRunnerService } from './hostedRunnerService.js';
import { githubAppService } from './githubAppService.js';
import { whatsappService } from './whatsappService.js';

/**
 * Store-subscription statuses that mean the person is still being billed by Apple or Google.
 *
 * `pending` is in the list on purpose: a purchase the store has not finished processing can still
 * become a charge, so it is exactly the case a warning must not omit.
 */
const BILLING_STORE_STATUSES: ReadonlySet<string> = new Set([
  'active',
  'grace_period',
  'pending',
  'on_hold',
]);

/**
 * Permanent account deletion.
 *
 * The promise this keeps is the one in `memory-and-learning.md` §5 — deletion is real, not hidden —
 * and the one Google Play's Data safety form requires before the app can ship. "Real" is doing a lot
 * of work in that sentence, because the majority of this user's data is NOT reachable by a foreign
 * key from `users`:
 *
 *  - **Vault ciphertext.** `connections.vault_ref`, `email_contacts.address_vault_ref` and
 *    `process_memory.subject_vault_ref` are plain `varchar` columns, not foreign keys
 *    (`003:16`, `024:25`, `010:32`), and `vault_secrets` has no `user_id` at all (`004:8-13`). Every
 *    one of those rows cascades away on delete while the encrypted Google refresh token, Plaid
 *    access token and contact address it pointed at stay in `vault_secrets` forever, now
 *    unattributable to anybody. They have to be collected BEFORE the delete or they are lost in
 *    place, which is the worst of both worlds: retained data nobody can even find to remove.
 *  - **Files on disk.** `media_assets` rows cascade; the voice notes, images and avatars under
 *    `UPLOADS_DIR` that they name do not.
 *  - **Grants at other companies.** A Google refresh token, a Plaid Item and a GitHub App
 *    installation all keep working after our row is gone. Deleting our record of a grant is not
 *    revoking it, and leaving one live is strictly worse than never having deleted anything —
 *    the user believes they are disconnected while the access continues.
 *  - **Containers.** A hosted runner holds the user's cloned repositories and uncommitted work in a
 *    Docker volume that no cascade reaches.
 *  - **Redis.** `presence:seen:{userId}` is written with no TTL and would outlive the account.
 *
 * ## Ordering, and why it is this way
 *
 * Everything that needs to READ user rows happens first, while they still exist; the `users` DELETE
 * is last. The one apparent exception is deliberate: media files are erased before the DB delete
 * because `media_assets.owner_id` cascades, so afterwards there is no way to learn which paths were
 * theirs.
 *
 * ## Failure policy, and why it is not uniform
 *
 * The fail-loud rule in this codebase forbids catching an error and continuing as though it did not
 * happen. Nothing here does that. But two genuinely different kinds of step are involved and they
 * get different, explicit treatment:
 *
 *  - Steps we control — media files, the vault sweep, the DB delete — **throw**. If they fail the
 *    deletion has not happened, the caller gets an error, and the user's account is still there to
 *    try again. A half-deleted account reported as deleted is the one outcome worth preventing.
 *  - Steps at a third party — Google's revoke endpoint, Plaid `/item/remove`, GitHub's uninstall,
 *    the provisioner — are attempted, and their outcome is RECORDED rather than assumed. A provider
 *    that is down must not permanently trap a user in an account they have asked to leave, and
 *    retrying forever is not available to a synchronous request. So each result lands in
 *    `AccountDeletionResult.revocations` and in the audit row, the user is told what could not be
 *    confirmed, and Sentry is told too. That is the opposite of swallowing: the failure is surfaced
 *    to three places instead of being converted into a success.
 */
export class AccountDeletionService {
  /**
   * What deleting this account would do, and anything that stops it.
   *
   * Exists so the confirmation screen can state consequences the user cannot otherwise know — that a
   * store subscription will keep charging them, that an organization is about to be destroyed — BEFORE
   * they type their password, rather than discovering it afterwards when nothing can be undone.
   */
  async preview(userId: string): Promise<AccountDeletionPreview> {
    const user = await userRepository.findById(userId);
    if (user === undefined) {
      throw new NotFoundError('User not found');
    }

    const blockers: AccountDeletionBlocker[] = [];
    const orgsToDelete: string[] = [];
    const orgsToLeave: string[] = [];
    const storeSubscriptions: string[] = [];

    for (const membership of await organizationRepository.listForUser(userId)) {
      const orgId = membership.org.id;
      const members = await organizationRepository.listMembers(orgId);
      const others = members.filter((m) => m.userId !== userId);

      if (others.length === 0) {
        // Nobody else can ever reach this tenant's data again, so retaining it would be keeping a
        // customer list with no controller. It goes with the account.
        orgsToDelete.push(membership.org.name);

        for (const sub of await storeSubscriptionRepository.listForOrg(orgId)) {
          if (BILLING_STORE_STATUSES.has(sub.status)) {
            storeSubscriptions.push(`${membership.org.name} (${sub.store})`);
          }
        }
        continue;
      }

      if (membership.role === 'owner' && (await organizationRepository.countOwners(orgId)) <= 1) {
        // Refused rather than resolved for them. Silently promoting somebody would hand a person
        // billing authority over a business without asking either of them; silently deleting the org
        // would destroy other people's work. Both are the user's call, and both are one action away.
        blockers.push({
          kind: 'sole_owner',
          orgName: membership.org.name,
          detail:
            `You are the only owner of “${membership.org.name}”, which has ` +
            `${String(others.length)} other member${others.length === 1 ? '' : 's'}. ` +
            `Make someone else an owner first, or the organization would be left with nobody ` +
            `who can invite, pay or administer it.`,
        });
        continue;
      }

      orgsToLeave.push(membership.org.name);
    }

    return {
      email: user.email,
      blockers,
      orgsToDelete,
      orgsToLeave,
      storeSubscriptions,
    };
  }

  /**
   * Delete the account for real. The caller MUST have re-verified the password first
   * (`authService.reverifyPassword`) — holding a session is not sufficient authority to destroy one.
   */
  async delete(userId: string): Promise<AccountDeletionResult> {
    const preview = await this.preview(userId);
    if (preview.blockers.length > 0) {
      throw new ConflictError(preview.blockers.map((b) => b.detail).join(' '));
    }

    // Audited BEFORE the delete, on purpose. `audit_log.user_id` is ON DELETE SET NULL and migration
    // 047 taught the append-only trigger to permit exactly that one update, so this row survives the
    // DELETE with its subject unlinked. The event that an account was deleted is precisely the event
    // that must not disappear along with the account.
    await auditWriter.write({
      userId,
      action: 'delete',
      resourceType: 'auth',
      resourceId: userId,
      summary: 'You permanently deleted your Stewra account.',
      success: true,
      metadata: {
        orgsDeleted: preview.orgsToDelete.length,
        orgsLeft: preview.orgsToLeave.length,
      },
    });

    const revocations = await this.revokeExternalGrants(userId);

    // Collected while the rows that name them still exist. After the DELETE these handles are
    // unreachable and the ciphertext they point at is orphaned permanently.
    const vaultRefs = await this.collectVaultRefs(userId);

    // Before the DELETE, because `media_assets.owner_id` cascades and takes the paths with it.
    const mediaFilesDeleted = await mediaService.deleteAllForOwner(userId);

    const orgIdsToDelete = await this.soleMemberOrgIds(userId);

    await db.transaction().execute(async (trx) => {
      // Orgs first: deleting the user would only CASCADE away their membership, leaving an
      // ownerless tenant holding a business's customers. Every `org_id` foreign key beneath
      // `organizations` is ON DELETE CASCADE, so this one statement takes the whole tenant.
      if (orgIdsToDelete.length > 0) {
        await trx.deleteFrom('organizations').where('id', 'in', orgIdsToDelete).execute();
      }

      // Conversations where this user was the last one standing. Since migration 062 the thread
      // survives its creator (so a group chat is not destroyed by whoever started it), which means
      // a 1:1 whose other party is gone — and the singleton `stewra_ai` thread — would otherwise
      // linger with no participants and no way to ever reach them.
      await trx
        .deleteFrom('conversations')
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('conversation_participants as other')
                .select('other.id')
                .whereRef('other.conversation_id', '=', 'conversations.id')
                .where('other.user_id', '!=', userId),
            ),
          ),
        )
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom('conversation_participants as mine')
              .select('mine.id')
              .whereRef('mine.conversation_id', '=', 'conversations.id')
              .where('mine.user_id', '=', userId),
          ),
        )
        .execute();

      const result = await trx.deleteFrom('users').where('id', '=', userId).executeTakeFirst();
      if (Number(result.numDeletedRows) !== 1) {
        throw new Error(
          `account deletion removed ${String(result.numDeletedRows)} user rows for ${userId}; expected exactly 1`,
        );
      }
    });

    // Only now that the referencing rows are gone. Doing this first would leave a live connection
    // pointing at a handle the vault no longer has, which reads as corruption rather than deletion.
    let vaultSecretsDeleted = 0;
    for (const ref of vaultRefs) {
      await vault.delete(ref);
      vaultSecretsDeleted += 1;
    }

    await presenceService.forgetUser(userId);

    logger.info('account deleted', {
      userId,
      vaultSecretsDeleted,
      mediaFilesDeleted,
      orgsDeleted: orgIdsToDelete.length,
    });

    return {
      deleted: true,
      vaultSecretsDeleted,
      mediaFilesDeleted,
      orgsDeleted: orgIdsToDelete.length,
      revocations,
    };
  }

  /** Ids of organizations where this user is the only member — the ones deletion takes with it. */
  private async soleMemberOrgIds(userId: string): Promise<string[]> {
    const ids: string[] = [];
    for (const membership of await organizationRepository.listForUser(userId)) {
      const members = await organizationRepository.listMembers(membership.org.id);
      if (members.every((m) => m.userId === userId)) {
        ids.push(membership.org.id);
      }
    }
    return ids;
  }

  /**
   * Every vault handle this user's rows point at.
   *
   * Read directly rather than through the repositories because there is no other caller for
   * "all of it, across all three tables" and inventing three list methods to serve one function
   * would spread the deletion's knowledge of the vault across the codebase. The queries are the
   * documentation: these are the only three columns in the schema that hold a `vault_secrets` id,
   * verified against the live database rather than assumed.
   */
  private async collectVaultRefs(userId: string): Promise<string[]> {
    const [connections, emailContacts, processRules] = await Promise.all([
      db.selectFrom('connections').select('vault_ref').where('user_id', '=', userId).execute(),
      db
        .selectFrom('email_contacts')
        .select('address_vault_ref')
        .where('user_id', '=', userId)
        .execute(),
      db
        .selectFrom('process_memory')
        .select('subject_vault_ref')
        .where('user_id', '=', userId)
        .execute(),
    ]);

    const refs = new Set<string>();
    for (const row of connections) {
      if (row.vault_ref.length > 0) refs.add(row.vault_ref);
    }
    for (const row of emailContacts) {
      if (row.address_vault_ref !== null && row.address_vault_ref.length > 0) {
        refs.add(row.address_vault_ref);
      }
    }
    for (const row of processRules) {
      if (row.subject_vault_ref !== null && row.subject_vault_ref.length > 0) {
        refs.add(row.subject_vault_ref);
      }
    }
    return [...refs];
  }

  /**
   * Sever every grant that lives at another company, and report what each one said.
   *
   * Mirrors `connectionController.disconnect`, which states the requirement: a disconnect "must
   * sever access everywhere, not just flip a local flag". Deletion is that, for every connection at
   * once — including `revoked` ones, because a connection revoked by a *lost grant* still holds its
   * ciphertext and is the case most likely to hold a token nobody ever confirmed was dead.
   *
   * Each entry records whether the provider actually acknowledged. Nothing here is presented to the
   * user as success on the strength of having been attempted.
   */
  private async revokeExternalGrants(
    userId: string,
  ): Promise<AccountDeletionResult['revocations']> {
    const revocations: Array<{ target: string; confirmed: boolean; detail: string | null }> = [];

    for (const connection of await connectionRepository.listAllForUser(userId)) {
      const target =
        connection.provider === 'aggregator'
          ? 'Bank connection'
          : `Google account ${connection.accountEmail}`;
      try {
        const secret = await vault.get(connection.vaultRef);
        const confirmed =
          connection.provider === 'aggregator'
            ? await removeItem(secret)
            : await revokeRefreshToken(secret);
        revocations.push({ target, confirmed, detail: null });
      } catch (error) {
        Sentry.captureException(error, {
          tags: { surface: 'account_deletion', step: 'revoke_connection' },
          extra: { userId, provider: connection.provider },
        });
        revocations.push({
          target,
          confirmed: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }

      // The per-source stores are purged explicitly for the same reason disconnect does it: these
      // rows key on `connection_id`, and the connection is about to disappear underneath them.
      try {
        if (connection.provider === 'aggregator') {
          await purgeConnectionMoneyData(connection.id);
        } else {
          await emailRetentionService.forgetForDisconnectedConnection(userId, connection.id);
        }
        await memoryService.forgetForDisconnectedProvider(userId, connection.provider);
        await processMemoryService.forgetForDisconnectedProvider(userId, connection.provider);
      } catch (error) {
        // Not fatal: everything this touches is `ON DELETE CASCADE` on `user_id`, so the rows go
        // regardless. What is lost on failure is the vaulted-address purge inside it — which is why
        // `collectVaultRefs` sweeps those columns independently rather than trusting this to have run.
        Sentry.captureException(error, {
          tags: { surface: 'account_deletion', step: 'purge_connection_store' },
          extra: { userId, connectionId: connection.id },
        });
      }
    }

    revocations.push(await this.attempt('GitHub App installation', () => githubAppService.unlink(userId)));
    revocations.push(await this.attempt('Hosted runner container', () => hostedRunnerService.destroy(userId)));
    revocations.push(await this.attempt('WhatsApp link', () => whatsappService.unlink(userId)));

    return revocations;
  }

  /**
   * Run one third-party teardown and turn its outcome into a reportable record.
   *
   * The `catch` is what makes the failure visible rather than fatal — it becomes a line the user
   * reads and an event Sentry receives. It never converts a failure into a success.
   */
  private async attempt(
    target: string,
    run: () => Promise<unknown>,
  ): Promise<{ target: string; confirmed: boolean; detail: string | null }> {
    try {
      await run();
      return { target, confirmed: true, detail: null };
    } catch (error) {
      Sentry.captureException(error, {
        tags: { surface: 'account_deletion', step: 'external_teardown' },
        extra: { target },
      });
      return {
        target,
        confirmed: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export const accountDeletionService = new AccountDeletionService();
