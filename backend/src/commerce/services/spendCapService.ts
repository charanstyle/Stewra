import type {
  CommerceSpendCap,
  CommerceSpendUsage,
  MessagePricingCategory,
} from '@stewra/shared-types';
import { spendCapRepository } from '../repositories/spendCapRepository.js';
import { rateCardRepository } from '../repositories/rateCardRepository.js';
import { db } from '../../database/index.js';
import { countryCallingCode } from './callingCodes.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors.js';

/**
 * The spend-cap policy in one place. The default it enforces is the platform's: **an organization
 * may spend nothing at third parties until headroom has been granted** — by an install operator
 * today, by a payment once the provider seam lands. Free and service-window messages never pass
 * through here; only money does.
 *
 * `SPEND_CAP` is the error code every refusal carries, so callers can tell "the cap said no" from
 * every other Forbidden the way they already tell `QUIET_HOURS` apart.
 */
class SpendCapService {
  /** Install-admin surface only. The controller sits behind requireInstallAdmin; this re-validates the data. */
  async setCap(params: {
    orgId: string;
    currency: string;
    limitMicros: string;
    note: string;
    grantedByUserId: string;
  }): Promise<CommerceSpendCap> {
    if (!/^\d{1,15}$/.test(params.limitMicros)) {
      throw new ValidationError('Validation failed', [
        { field: 'limitMicros', message: 'Must be a decimal string of micros, 0 to 10^15.' },
      ]);
    }
    const org = await db
      .selectFrom('organizations')
      .select('id')
      .where('id', '=', params.orgId)
      .executeTakeFirst();
    if (org === undefined) throw new NotFoundError('Organization not found');
    return spendCapRepository.setCap({
      orgId: params.orgId,
      currency: params.currency,
      limitMicros: BigInt(params.limitMicros),
      grantedByUserId: params.grantedByUserId,
      note: params.note,
    });
  }

  async listCaps(orgId: string): Promise<CommerceSpendCap[]> {
    return spendCapRepository.listCaps(orgId);
  }

  async usage(orgId: string): Promise<CommerceSpendUsage[]> {
    return spendCapRepository.usage(orgId, new Date());
  }

  /**
   * The gate at every point that would put billable work in motion — create, resume, and the
   * dispatch job. Positive headroom this month or a refusal that names the state; a WABA that
   * never reported its billing currency is also a refusal, because spend that cannot be priced
   * cannot be limited, and the default is zero, not "unpriceable, so go ahead".
   */
  async assertHeadroom(orgId: string, billingCurrency: string | null): Promise<void> {
    if (billingCurrency === null) {
      throw new ForbiddenError(
        'This WhatsApp account never reported its billing currency, so sends through it cannot be ' +
          'priced against a spend cap — and unpriceable spend is not allowed. Reconnect the ' +
          'account so Meta reports the currency.',
        'SPEND_CAP',
      );
    }
    const headroom = await spendCapRepository.headroom(orgId, billingCurrency, new Date());
    if (headroom <= 0n) {
      throw new ForbiddenError(
        `This organization has no ${billingCurrency} spend headroom this month. Paid messages are ` +
          'not allowed until a spend cap is granted or raised.',
        'SPEND_CAP',
      );
    }
  }

  /** Same predicate as {@link assertHeadroom}, as a boolean for job handlers that pause rather than throw. */
  async hasHeadroom(orgId: string, billingCurrency: string | null): Promise<boolean> {
    if (billingCurrency === null) return false;
    const headroom = await spendCapRepository.headroom(orgId, billingCurrency, new Date());
    return headroom > 0n;
  }

  /**
   * What one send to this recipient is expected to cost — the SAME lookup the rater will make when
   * the receipt lands, so reservation and settlement usually agree to the micro. Null when the
   * price cannot be established (unknown country, no rate on the card): an amount that cannot be
   * named cannot be reserved, and under a zero-spend default that send is refused, not waved past.
   */
  async estimateSendMicros(params: {
    billingCurrency: string;
    recipientExternalId: string;
    pricingCategory: MessagePricingCategory;
  }): Promise<bigint | null> {
    const code = countryCallingCode(`+${params.recipientExternalId}`);
    if (code === null) return null;
    const rate = await rateCardRepository.resolveRate({
      currency: params.billingCurrency,
      at: new Date(),
      countryCallingCode: code,
      pricingCategory: params.pricingCategory,
    });
    return rate === null ? null : rate.amountMicros;
  }

  /** Hold estimated money for a message about to be sent. 'insufficient' includes "no cap exists". */
  async reserve(params: {
    orgId: string;
    currency: string;
    amountMicros: bigint;
    messageId: string;
    broadcastId: string | null;
  }): Promise<'reserved' | 'insufficient'> {
    return spendCapRepository.reserve({ ...params, at: new Date() });
  }

  /** Meta refused the send — the money was certainly not spent. Idempotent. */
  async releaseForRefusedSend(messageId: string, note: string): Promise<void> {
    await spendCapRepository.closeReservation({ messageId, outcome: 'release', note });
  }

  /**
   * A receipt priced the message: move its reservation to actuals at the real charge. Called by
   * the rater for the three priced states; unrated states deliberately keep their reservation
   * held — the money may have been spent, and an unpriceable charge must not free headroom.
   */
  async settleFromRating(params: {
    orgId: string;
    messageId: string;
    amountMicros: bigint;
    currency: string | null;
  }): Promise<void> {
    const outcome = await spendCapRepository.closeReservation(
      params.currency === null
        ? { messageId: params.messageId, outcome: 'settle', actualMicros: params.amountMicros }
        : {
            messageId: params.messageId,
            outcome: 'settle',
            actualMicros: params.amountMicros,
            actualCurrency: params.currency,
          },
    );
    if (outcome === 'no_reservation' || outcome === 'closed_currency_mismatch') {
      // Real spend with no (usable) hold behind it — a customer-opened conversation, a send from
      // before the cap, or a WABA whose currency changed mid-flight. Booked as-is; zero charges
      // add nothing and are skipped.
      if (params.amountMicros > 0n && params.currency !== null) {
        await spendCapRepository.recordUnreservedActual({
          orgId: params.orgId,
          currency: params.currency,
          amountMicros: params.amountMicros,
          messageId: params.messageId,
          at: new Date(),
        });
      }
    }
  }
}

export const spendCapService = new SpendCapService();
