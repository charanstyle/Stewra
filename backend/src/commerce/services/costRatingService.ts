import type { MessagePricingCategory } from '@stewra/shared-types';
import { db } from '../../database/index.js';
import { logger } from '../../utils/logger.js';
import { messageCostRepository } from '../repositories/messageCostRepository.js';
import type { CostOutcome } from '../repositories/messageCostRepository.js';
import { rateCardRepository } from '../repositories/rateCardRepository.js';
import { countryCallingCode } from './callingCodes.js';

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
    }
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
