import { channelAccountRepository } from '../repositories/channelAccountRepository.js';
import type { ChannelAccountRow } from '../repositories/channelAccountRepository.js';
import { jobRepository } from '../repositories/jobRepository.js';
import { metaEmbeddedSignupService } from './metaEmbeddedSignupService.js';
import { config } from '../../config/unifiedConfig.js';
import { vault } from '../../control-plane/vault/vault.js';
import { logger } from '../../utils/logger.js';

/**
 * KEEPING A CONNECTED CHANNEL CONNECTED.
 *
 * Embedded Signup does not hand out a permanent credential. The only Meta login configuration that
 * grants the full WhatsApp management permission set — "WhatsApp Embedded Signup Configuration With
 * 60 Expiration Token" — issues a token that dies 60 days after the client approves the dialog.
 * Sixty days after a successful onboarding is exactly when nobody is watching, so without this the
 * first symptom would be a business discovering its customers had been unable to reach it.
 *
 * Two jobs, in this order of importance:
 *
 *  1. **Say when.** The deadline is stored on the row and published on the API model, so the app can
 *     show it long before it matters. This is the part that always works.
 *  2. **Try to move it.** `grant_type=fb_exchange_token` is the only renewal Meta offers that does
 *     not put the client back through the dialog. Whether it actually extends a 60-day Embedded
 *     Signup token is NOT assumed here — the new deadline is read back from Meta and compared. If it
 *     did not move, nothing is rotated and the client keeps being shown the original deadline.
 *
 * The deliberate non-behaviour: a token that is merely *approaching* expiry never marks the channel
 * broken. It still works, and a business told to stop is a business that stopped for no reason. Only
 * a credential that has actually passed its deadline is marked `error`, and then it says so in words.
 */

/** How long before the deadline a renewal is attempted. */
const REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How much later a returned deadline has to be before the exchange counts as having worked.
 *
 * Meta can hand back a token whose expiry is the same instant, or seconds different for reasons that
 * are not a renewal. Rotating the vaulted secret for that would be churn with no benefit, and — more
 * to the point — would let "we tried" masquerade as "it is fixed" in the one place a client is
 * relying on us to tell them the truth.
 */
const MEANINGFUL_EXTENSION_MS = 24 * 60 * 60 * 1000;

/** What one attempt did. Returned rather than logged-and-forgotten so the sweep can summarise. */
export type TokenRefreshOutcome =
  /** Meta issued a credential with a materially later deadline; the vault now holds it. */
  | 'extended'
  /** The exchange worked but bought no time. Nothing rotated; the client must reconnect. */
  | 'not-extended'
  /** Already past its deadline. Marked `error`, with the reason in words. */
  | 'expired'
  /** Meta refused, or the stored secret could not be read. The old credential is untouched. */
  | 'failed';

class ChannelTokenService {
  /**
   * Put every credential nearing or past its deadline on the job queue. Returns how many were
   * enqueued — jobs already scheduled today are not counted, because they were not enqueued here.
   *
   * This used to do the renewals itself, inline, on an hourly timer. It does not any more, and the
   * reason is the one thing a timer cannot do: try again. `refresh` reaches Meta's Graph API, which
   * fails the way every HTTP dependency fails, and the old behaviour on a refusal was to log it and
   * wait a full hour to learn whether it had been transient. Through the queue the same refusal is
   * retried in four seconds, then sixteen, then a minute, and if it still will not go through it
   * lands in `dead` where someone can see it — instead of in a log line nobody reads.
   *
   * The dedupe key is per account per UTC day. One day's worth of attempts, then a fresh job
   * tomorrow: without the date a permanently-dead job would block that account from ever being tried
   * again, and without the account id two orgs would collide.
   */
  async enqueueDueRefreshes(): Promise<number> {
    if (!config.metaCommerce.enabled) return 0;

    const rows = await channelAccountRepository.listExpiringBefore(
      new Date(Date.now() + REFRESH_WINDOW_MS),
    );
    if (rows.length === 0) return 0;

    const today = new Date().toISOString().slice(0, 10);
    let enqueued = 0;
    for (const row of rows) {
      const job = await jobRepository.enqueue({
        orgId: row.orgId,
        kind: 'channel_token_refresh',
        payload: { channelAccountId: row.id },
        dedupeKey: `channel_token_refresh:${row.id}:${today}`,
      });
      if (job !== null) enqueued += 1;
    }
    logger.info('commerce: channel credential refreshes enqueued', {
      due: rows.length,
      enqueued,
    });
    return enqueued;
  }

  /**
   * Renew one account's credential, or record why it could not be.
   *
   * Never throws. Every path ends in an outcome the caller can count, because the alternative — an
   * exception escaping into a background timer — is how a sweep silently stops running.
   */
  async refresh(row: ChannelAccountRow): Promise<TokenRefreshOutcome> {
    if (row.credentialExpiresAt === null) {
      // Not reachable through `sweep`, whose query excludes NULLs. Reachable if someone calls this
      // directly, and doing nothing is the right answer: a credential with no deadline has nothing
      // to renew.
      return 'not-extended';
    }

    const expiresAt = new Date(row.credentialExpiresAt);
    if (expiresAt.getTime() <= Date.now()) {
      return this.markExpired(row, expiresAt);
    }

    let currentToken: string;
    try {
      currentToken = await vault.get(row.credentialRef);
    } catch (error) {
      // The row says connected while the thing that makes it connected is gone. Said out loud, in
      // the same words `channelAccountService.resolve` uses, so a client sees one explanation rather
      // than two for the same fault.
      const detail = 'Stored credential is missing or unreadable. Reconnect this account.';
      await channelAccountRepository.markError(row.id, detail);
      logger.error('commerce: credential could not be read during the expiry sweep', {
        channelAccountId: row.id,
        orgId: row.orgId,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'failed';
    }

    let renewed: Awaited<ReturnType<typeof metaEmbeddedSignupService.extendCredential>>;
    try {
      renewed = await metaEmbeddedSignupService.extendCredential(currentToken);
    } catch (error) {
      // The existing token is still valid until its deadline, so nothing is marked broken here. The
      // deadline the client is already being shown is what carries this case.
      logger.warn('commerce: Meta refused to extend a channel credential', {
        channelAccountId: row.id,
        orgId: row.orgId,
        expiresAt: row.credentialExpiresAt,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'failed';
    }

    // A null new deadline means Meta now reports the credential as non-expiring — the best possible
    // outcome, and one that has to be stored, not treated as a missing value.
    const movedEnough =
      renewed.expiresAt === null ||
      renewed.expiresAt.getTime() - expiresAt.getTime() >= MEANINGFUL_EXTENSION_MS;

    if (!movedEnough) {
      logger.warn('commerce: token exchange returned no additional lifetime — reconnect required', {
        channelAccountId: row.id,
        orgId: row.orgId,
        was: row.credentialExpiresAt,
        now: renewed.expiresAt?.toISOString() ?? null,
      });
      return 'not-extended';
    }

    const credentialRef = await vault.put(renewed.token);
    const superseded = await channelAccountRepository.replaceCredential({
      id: row.id,
      credentialRef,
      credentialExpiresAt: renewed.expiresAt,
      // A channel marked `error` because its credential EXPIRED is fixed by this and should say so.
      // One marked `error` for a rejected registration PIN is not, and is deliberately left alone —
      // a new token does not register a phone number.
      clearExpiryError: row.status === 'error' && this.isExpiryError(row.errorDetail),
    });

    if (superseded === null && row.credentialRef !== credentialRef) {
      // The account was disconnected while Meta was answering. The secret just written references
      // nothing, and leaving it would be an orphaned credential at rest.
      await vault.delete(credentialRef);
      logger.info('commerce: account disconnected mid-renewal, new credential discarded', {
        channelAccountId: row.id,
      });
      return 'failed';
    }
    if (superseded !== null) {
      await vault.delete(superseded);
    }

    logger.info('commerce: channel credential extended', {
      channelAccountId: row.id,
      orgId: row.orgId,
      was: row.credentialExpiresAt,
      now: renewed.expiresAt?.toISOString() ?? null,
    });
    return 'extended';
  }

  /** The wording used for an expired credential, and the test for recognising one we wrote. */
  private expiredDetail(expiresAt: Date): string {
    return (
      `The WhatsApp access this business granted expired on ${expiresAt.toISOString().slice(0, 10)}. ` +
      'Reconnect the account to resume sending — Meta requires the business owner to approve the ' +
      'dialog again.'
    );
  }

  private isExpiryError(errorDetail: string | null): boolean {
    return errorDetail !== null && errorDetail.startsWith('The WhatsApp access this business granted');
  }

  private async markExpired(row: ChannelAccountRow, expiresAt: Date): Promise<TokenRefreshOutcome> {
    if (row.status === 'error' && this.isExpiryError(row.errorDetail)) {
      // Already said. Rewriting it every hour would churn the row and add nothing.
      return 'expired';
    }
    await channelAccountRepository.markError(row.id, this.expiredDetail(expiresAt));
    logger.warn('commerce: channel credential expired, account marked for reconnect', {
      channelAccountId: row.id,
      orgId: row.orgId,
      expiredAt: expiresAt.toISOString(),
    });
    return 'expired';
  }
}

export const channelTokenService = new ChannelTokenService();
