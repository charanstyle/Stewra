import type { MessagePricingCategory } from '@stewra/shared-types';
import { db } from '../../database/index.js';
import { logger } from '../../utils/logger.js';
import { messageCostRepository } from '../repositories/messageCostRepository.js';
import type { CostOutcome } from '../repositories/messageCostRepository.js';
import { rateCardRepository } from '../repositories/rateCardRepository.js';
import { countryCallingCode } from './callingCodes.js';
import { spendCapService } from './spendCapService.js';

/**
 * Turn a delivery receipt's pricing facts into one cost row — the moment a message's price is
 * established, or honestly refused.
 *
 * The decision ladder never guesses past a gap: each rung that cannot be climbed writes its own
 * `unrated_*` state with a NULL amount, and the message surfaces on the cost report as a
 * discrepancy instead of becoming a made-up number. What IS established is snapshotted whole
 * (card, per-unit rate, currency, country, category), so no later change to any of those inputs
 * can silently move an amount that has already been written.
 */
class CostRatingService {
  /**
   * Rate one message from its post-receipt merged pricing facts. Called only when `billable` is
   * known (true or false) — a receipt with no pricing block leaves no row, keeping
   * `unpricedMessages` the single count of "Meta has not said yet".
   */
  async rateMessage(params: {
    orgId: string;
    messageId: string;
    conversationId: string;
    billable: boolean;
    pricingCategory: MessagePricingCategory | null;
    providerConversationId: string | null;
    billingCurrency: string | null;
  }): Promise<void> {
    const base: Omit<CostOutcome, 'state'> = {
      orgId: params.orgId,
      messageId: params.messageId,
      billable: params.billable,
      currency: params.billingCurrency,
      pricingCategory: params.pricingCategory,
      countryCallingCode: null,
      providerConversationId: params.providerConversationId,
      rateCardId: null,
      unit: null,
      rateAmountMicros: null,
      amountMicros: null,
    };

    // Meta said free. Zero, in whatever currency we know (or none) — no rate lookup involved.
    if (!params.billable) {
      await this.write({ ...base, state: 'free', amountMicros: 0n });
      await spendCapService.settleFromRating({
        orgId: params.orgId,
        messageId: params.messageId,
        amountMicros: 0n,
        currency: params.billingCurrency,
      });
      return;
    }

    if (params.pricingCategory === null) {
      await this.write({ ...base, state: 'unrated_no_category' });
      return;
    }
    if (params.billingCurrency === null) {
      await this.write({ ...base, state: 'unrated_no_currency' });
      return;
    }

    const callingCode = await this.recipientCallingCode(params.orgId, params.conversationId);
    if (callingCode === null) {
      await this.write({ ...base, state: 'unrated_no_country' });
      return;
    }

    const rate = await rateCardRepository.resolveRate({
      currency: params.billingCurrency,
      // The price of a message is the price of the era it is PRICED in — `priced_at` and this
      // lookup use the same instant, which is what lets a late receipt bill into the open period
      // instead of reopening a closed one.
      at: new Date(),
      countryCallingCode: callingCode,
      pricingCategory: params.pricingCategory,
    });
    if (rate === null) {
      await this.write({ ...base, state: 'unrated_no_rate', countryCallingCode: callingCode });
      return;
    }

    const rated: CostOutcome = {
      ...base,
      state: 'rated',
      countryCallingCode: callingCode,
      rateCardId: rate.rateCardId,
      unit: rate.unit,
      rateAmountMicros: rate.amountMicros,
      amountMicros: rate.amountMicros,
    };
    const result = await messageCostRepository.insertOutcome(rated);
    if (result === 'conversation_already_charged') {
      // Conversation pricing: the charge sits on whichever message won the partial unique index;
      // this one records the same provenance at zero, so the conversation's message count and its
      // single charge are both visible.
      await this.write({ ...rated, state: 'rated_zero_conversation_dup', amountMicros: 0n });
      await spendCapService.settleFromRating({
        orgId: params.orgId,
        messageId: params.messageId,
        amountMicros: 0n,
        currency: params.billingCurrency,
      });
      return;
    }
    // The receipt priced it — the spend cap's reservation settles at what Meta actually charged.
    // Idempotent (the ledger allows one closing entry per message), so a replayed webhook that
    // reached the already_rated no-op above cannot credit a period twice. The unrated states above
    // deliberately never settle: money that cannot be priced must not free headroom.
    await spendCapService.settleFromRating({
      orgId: params.orgId,
      messageId: params.messageId,
      amountMicros: rate.amountMicros,
      currency: params.billingCurrency,
    });
  }

  /**
   * Retry an `unrated_*` message against today's cards, replacing the row ONLY when the retry
   * would actually price it.
   *
   * The condition is the whole design. An unconditional rewrite would stamp a fresh `priced_at` on
   * a still-unpriceable row every hourly pass — the discrepancy would migrate from period to
   * period, each one closing behind it, and "a period with unrated messages stays open" would be
   * quietly false. A row that stays unpriceable therefore stays put, holding its period open until
   * the operator loads the missing rate; the moment that rate exists, this prices the message into
   * the CURRENT period (same late-receipt policy as everything else) and the stuck period closes
   * on the next sweep.
   */
  async reRateMessage(params: {
    orgId: string;
    messageId: string;
    conversationId: string;
    billable: boolean;
    pricingCategory: MessagePricingCategory | null;
    providerConversationId: string | null;
    billingCurrency: string | null;
  }): Promise<'re_rated' | 'still_unrated'> {
    // The same ladder as rateMessage, climbed WITHOUT writing: any rung that fails means the
    // outcome would be another unrated row, and the existing one is already the truth.
    if (!params.billable) return 'still_unrated'; // unreachable for unrated rows; belt only.
    if (params.pricingCategory === null || params.billingCurrency === null) return 'still_unrated';
    const callingCode = await this.recipientCallingCode(params.orgId, params.conversationId);
    if (callingCode === null) return 'still_unrated';
    const rate = await rateCardRepository.resolveRate({
      currency: params.billingCurrency,
      at: new Date(),
      countryCallingCode: callingCode,
      pricingCategory: params.pricingCategory,
    });
    if (rate === null) return 'still_unrated';

    const rated: CostOutcome = {
      orgId: params.orgId,
      messageId: params.messageId,
      state: 'rated',
      billable: true,
      currency: params.billingCurrency,
      pricingCategory: params.pricingCategory,
      countryCallingCode: callingCode,
      providerConversationId: params.providerConversationId,
      rateCardId: rate.rateCardId,
      unit: rate.unit,
      rateAmountMicros: rate.amountMicros,
      amountMicros: rate.amountMicros,
    };
    const result = await messageCostRepository.replaceUnratedOutcome(rated);
    if (result === 'conversation_already_charged') {
      await this.write({ ...rated, state: 'rated_zero_conversation_dup', amountMicros: 0n });
      await spendCapService.settleFromRating({
        orgId: params.orgId,
        messageId: params.messageId,
        amountMicros: 0n,
        currency: params.billingCurrency,
      });
      return 're_rated';
    }
    await spendCapService.settleFromRating({
      orgId: params.orgId,
      messageId: params.messageId,
      amountMicros: rate.amountMicros,
      currency: params.billingCurrency,
    });
    return 're_rated';
  }

  private async write(outcome: CostOutcome): Promise<void> {
    const result = await messageCostRepository.insertOutcome(outcome);
    if (result === 'conversation_already_charged') {
      // Only the 'rated' insert can trip the conversation index; any other state reaching this is
      // a schema assumption broken, and continuing would bill wrongly in silence.
      throw new Error(
        `commerce cost rating: unexpected conversation-charge conflict writing state '${outcome.state}' for message ${outcome.messageId}`,
      );
    }
    if (result === 'already_rated') {
      logger.debug('commerce cost rating: message already rated — replayed receipt ignored', {
        orgId: outcome.orgId,
        messageId: outcome.messageId,
      });
    }
  }

  /**
   * The recipient's country, from the contact the conversation belongs to. `phone_e164` when the
   * contact has one; otherwise the WhatsApp `external_id`, which Meta defines as E.164 digits
   * without the '+'. Null — an unassigned code, a non-phone platform id — means `unrated_no_country`.
   */
  private async recipientCallingCode(orgId: string, conversationId: string): Promise<string | null> {
    const row = await db
      .selectFrom('commerce_conversations')
      .innerJoin('commerce_contacts', 'commerce_contacts.id', 'commerce_conversations.contact_id')
      .select(['commerce_contacts.phone_e164', 'commerce_contacts.external_id'])
      .where('commerce_conversations.id', '=', conversationId)
      .where('commerce_conversations.org_id', '=', orgId)
      .executeTakeFirst();
    if (row === undefined) return null;
    const phone = row.phone_e164 ?? `+${row.external_id}`;
    return countryCallingCode(phone);
  }
}

export const costRatingService = new CostRatingService();
