import type { ChannelAccount } from '@stewra/shared-types';
import type { CommerceSender, ResolvedChannelAccount } from './senders/index.js';
import { buildSender } from './senders/index.js';
import {
  channelAccountRepository,
  toChannelAccount,
} from '../repositories/channelAccountRepository.js';
import type { ChannelAccountRow } from '../repositories/channelAccountRepository.js';
import { vault } from '../../control-plane/vault/vault.js';
import { NotFoundError, ServiceUnavailableError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

/**
 * Turning a connected account into something that can actually send.
 *
 * The credential is fetched from the vault at the moment of use and handed straight to a
 * freshly-built sender. It is never cached, never attached to a long-lived object, and never
 * returned upward — {@link listForOrg} deliberately maps through `toChannelAccount`, which has no
 * field for it, so there is no code path that could serialize one into a response.
 */
class ChannelAccountService {
  async listForOrg(orgId: string): Promise<ChannelAccount[]> {
    const rows = await channelAccountRepository.listForOrg(orgId);
    return rows.map(toChannelAccount);
  }

  /**
   * Resolve a row's vault handle into a usable credential.
   *
   * A missing secret is a real failure, not an empty result: the row says the account is connected
   * while the thing that makes it connected is gone. The account is marked `error` with that reason
   * in words — so the client is asked to reconnect — and then it throws. Returning "no credential"
   * would let a campaign count this recipient as attempted.
   */
  async resolve(row: ChannelAccountRow): Promise<ResolvedChannelAccount> {
    if (row.status !== 'active') {
      throw new ServiceUnavailableError(
        `This channel is ${row.status}${row.errorDetail === null ? '' : `: ${row.errorDetail}`}. Reconnect it to send.`,
      );
    }

    let accessToken: string;
    try {
      accessToken = await vault.get(row.credentialRef);
    } catch (error) {
      const detail = 'Stored credential is missing or unreadable. Reconnect this account.';
      await channelAccountRepository.markError(row.id, detail);
      logger.error('commerce: channel account credential could not be read', {
        channelAccountId: row.id,
        orgId: row.orgId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ServiceUnavailableError(detail);
    }

    return {
      id: row.id,
      orgId: row.orgId,
      platform: row.platform,
      externalAccountId: row.externalAccountId,
      phoneNumberId: row.phoneNumberId,
      accessToken,
    };
  }

  /** A sender for one of the org's accounts, or 404 if that account is not this org's. */
  async senderFor(orgId: string, channelAccountId: string): Promise<CommerceSender> {
    const row = await channelAccountRepository.findForOrg(orgId, channelAccountId);
    if (row === null) {
      throw new NotFoundError('Channel account not found');
    }
    return buildSender(await this.resolve(row));
  }

  /**
   * Disconnect an account: drop the row, then delete the secret it referenced.
   *
   * In that order on purpose. If the delete fails between the two, what is left is an unreferenced
   * secret in the vault — inert, and findable. The reverse order would leave a row that claims to be
   * connected and cannot send, which is the state a client would keep trying to use.
   */
  async disconnect(orgId: string, channelAccountId: string): Promise<boolean> {
    const row = await channelAccountRepository.findForOrg(orgId, channelAccountId);
    if (row === null) {
      throw new NotFoundError('Channel account not found');
    }
    const removed = await channelAccountRepository.remove(orgId, channelAccountId);
    if (removed) {
      await vault.delete(row.credentialRef);
    }
    return removed;
  }
}

export const channelAccountService = new ChannelAccountService();
