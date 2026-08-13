import { sql } from 'kysely';
import type {
  CommerceMoneySummary,
  MessageCostState,
  MessageCostUnratedReason,
  MessagePricingCategory,
  RateUnit,
} from '@stewra/shared-types';
import { db } from '../../database/index.js';
import { isUniqueViolation } from '../../database/pgErrors.js';

export interface CostOutcome {
  orgId: string;
  messageId: string;
  state: MessageCostState;
  billable: boolean;
  currency: string | null;
  pricingCategory: MessagePricingCategory | null;
  countryCallingCode: string | null;
  providerConversationId: string | null;
  rateCardId: string | null;
  unit: RateUnit | null;
  rateAmountMicros: bigint | null;
  amountMicros: bigint | null;
}

const UNRATED_REASONS: readonly MessageCostUnratedReason[] = [
  'unrated_no_category',
  'unrated_no_currency',
  'unrated_no_country',
  'unrated_no_rate',
];

/**
 * The cost rows themselves. Insert-once semantics carried by two unique indexes, each with its own
 * meaning: `message_id` makes rating idempotent under Meta's webhook retries, and the partial
 * conversation index makes conversation pricing charge once even under concurrent workers.
 */
class MessageCostRepository {
  /**
   * Record a rating outcome, exactly once per message.
   *
   * Returns 'written' | 'already_rated' | 'conversation_already_charged'. The third is the one
   * with a decision attached: the caller retries the same outcome as the zero-amount duplicate.
   * `ON CONFLICT DO NOTHING` cannot express that — the two indexes need different reactions, so
   * the message_id conflict is targeted and the conversation conflict is caught and named.
   */
  async insertOutcome(
    outcome: CostOutcome,
  ): Promise<'written' | 'already_rated' | 'conversation_already_charged'> {
    try {
      const inserted = await db
        .insertInto('commerce_message_costs')
        .values({
          org_id: outcome.orgId,
          message_id: outcome.messageId,
          state: outcome.state,
          billable: outcome.billable,
          currency: outcome.currency,
          pricing_category: outcome.pricingCategory,
          country_calling_code: outcome.countryCallingCode,
          provider_conversation_id: outcome.providerConversationId,
          rate_card_id: outcome.rateCardId,
          unit: outcome.unit,
          rate_amount_micros: outcome.rateAmountMicros?.toString() ?? null,
          amount_micros: outcome.amountMicros?.toString() ?? null,
        })
        .onConflict((oc) => oc.column('message_id').doNothing())
        .executeTakeFirst();
      return Number(inserted.numInsertedOrUpdatedRows ?? 0) > 0 ? 'written' : 'already_rated';
    } catch (error) {
      // The only other unique index on this table is the conversation charge; a violation here IS
      // that index saying "someone else holds this conversation's charge".
      if (isUniqueViolation(error)) return 'conversation_already_charged';
      throw error;
    }
  }

  /** The money block for `GET /orgs/:orgId/costs`, cut on `priced_at` — see the migration. */
  async moneySummary(params: {
    orgId: string;
    from: Date;
    to: Date;
  }): Promise<Omit<CommerceMoneySummary, 'complete'>> {
    const rows = await db
      .selectFrom('commerce_message_costs')
      .select(['state', 'currency'])
      .select(({ fn }) => fn.countAll<string>().as('messages'))
      .select(sql<string | null>`sum(amount_micros)`.as('total_micros'))
      .where('org_id', '=', params.orgId)
      .where('priced_at', '>=', params.from)
      .where('priced_at', '<', params.to)
      .groupBy(['state', 'currency'])
      .execute();

    const byCurrency: Record<
      string,
      { ratedMicros: string; ratedMessages: number; conversationDupMessages: number }
    > = {};
    const bucket = (currency: string) =>
      (byCurrency[currency] ??= { ratedMicros: '0', ratedMessages: 0, conversationDupMessages: 0 });

    let freeMessages = 0;
    const unratedBillable: Record<MessageCostUnratedReason, number> = {
      unrated_no_category: 0,
      unrated_no_currency: 0,
      unrated_no_country: 0,
      unrated_no_rate: 0,
    };

    for (const row of rows) {
      const messages = Number(row.messages);
      if (row.state === 'free') {
        freeMessages += messages;
      } else if (row.state === 'rated') {
        if (row.currency === null) throw new Error('rated cost row with no currency — CHECK constraint hole');
        const entry = bucket(row.currency);
        entry.ratedMessages += messages;
        entry.ratedMicros = (BigInt(entry.ratedMicros) + BigInt(row.total_micros ?? '0')).toString();
      } else if (row.state === 'rated_zero_conversation_dup') {
        if (row.currency === null) throw new Error('conversation-dup cost row with no currency — CHECK constraint hole');
        bucket(row.currency).conversationDupMessages += messages;
      } else {
        unratedBillable[row.state] += messages;
      }
    }

    return { byCurrency, freeMessages, unratedBillable };
  }

  /** Whether any billable message in the window could not be priced. One input to `complete`. */
  hasUnrated(summary: Omit<CommerceMoneySummary, 'complete'>): boolean {
    return UNRATED_REASONS.some((reason) => summary.unratedBillable[reason] > 0);
  }

  /**
   * Messages whose receipt carried pricing (`billable` is known) but which have NO cost row — the
   * rater erred mid-flight, or the process died between the receipt and the rating. The backfill
   * feeds these straight back into `rateMessage`, joined here with everything it needs so the
   * handler runs one query per batch, not one per message.
   */
  async receiptsAwaitingRating(params: {
    orgId: string;
    limit: number;
  }): Promise<
    {
      messageId: string;
      conversationId: string;
      billable: boolean;
      pricingCategory: MessagePricingCategory | null;
      providerConversationId: string | null;
      billingCurrency: string | null;
    }[]
  > {
    const rows = await db
      .selectFrom('commerce_messages')
      .innerJoin(
        'commerce_conversations',
        'commerce_conversations.id',
        'commerce_messages.conversation_id',
      )
      .innerJoin(
        'channel_accounts',
        'channel_accounts.id',
        'commerce_conversations.channel_account_id',
      )
      .select([
        'commerce_messages.id as message_id',
        'commerce_messages.conversation_id as conversation_id',
        'commerce_messages.billable as billable',
        'commerce_messages.pricing_category as pricing_category',
        'commerce_messages.provider_conversation_id as provider_conversation_id',
        'channel_accounts.billing_currency as billing_currency',
      ])
      .where('commerce_messages.org_id', '=', params.orgId)
      .where('commerce_messages.billable', 'is not', null)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('commerce_message_costs')
              .select('commerce_message_costs.id')
              .whereRef('commerce_message_costs.message_id', '=', 'commerce_messages.id'),
          ),
        ),
      )
      .orderBy('commerce_messages.created_at')
      .limit(params.limit)
      .execute();
    return rows.map((row) => ({
      messageId: row.message_id,
      conversationId: row.conversation_id,
      // The `is not null` predicate guarantees this; the type still says nullable.
      billable: row.billable === true,
      pricingCategory: row.pricing_category,
      providerConversationId: row.provider_conversation_id,
      billingCurrency: row.billing_currency,
    }));
  }

  /**
   * Cost rows the rater refused (`unrated_*`), with the same rating inputs re-joined. The backfill
   * retries these against today's cards; a row that is STILL unpriceable is left exactly where it
   * is — see `replaceUnratedOutcome` for why the replacement is conditional.
   */
  async unratedOutcomes(params: {
    orgId: string;
    limit: number;
  }): Promise<
    {
      messageId: string;
      conversationId: string;
      billable: boolean;
      pricingCategory: MessagePricingCategory | null;
      providerConversationId: string | null;
      billingCurrency: string | null;
    }[]
  > {
    const rows = await db
      .selectFrom('commerce_message_costs')
      .innerJoin('commerce_messages', 'commerce_messages.id', 'commerce_message_costs.message_id')
      .innerJoin(
        'commerce_conversations',
        'commerce_conversations.id',
        'commerce_messages.conversation_id',
      )
      .innerJoin(
        'channel_accounts',
        'channel_accounts.id',
        'commerce_conversations.channel_account_id',
      )
      .select([
        'commerce_messages.id as message_id',
        'commerce_messages.conversation_id as conversation_id',
        'commerce_messages.billable as billable',
        'commerce_messages.pricing_category as pricing_category',
        'commerce_messages.provider_conversation_id as provider_conversation_id',
        'channel_accounts.billing_currency as billing_currency',
      ])
      .where('commerce_message_costs.org_id', '=', params.orgId)
      .where('commerce_message_costs.state', 'in', UNRATED_REASONS)
      .orderBy('commerce_message_costs.priced_at')
      .limit(params.limit)
      .execute();
    return rows.map((row) => ({
      messageId: row.message_id,
      conversationId: row.conversation_id,
      billable: row.billable === true,
      pricingCategory: row.pricing_category,
      providerConversationId: row.provider_conversation_id,
      billingCurrency: row.billing_currency,
    }));
  }

  /**
   * Swap one message's `unrated_*` row for a priced outcome the backfill just computed. The delete
   * is state-guarded: if a concurrent pass already replaced it, the delete removes nothing and the
   * insert lands on the message_id index as `already_rated` — never two rows, never a lost amount.
   */
  async replaceUnratedOutcome(
    outcome: CostOutcome,
  ): Promise<'written' | 'already_rated' | 'conversation_already_charged'> {
    await db
      .deleteFrom('commerce_message_costs')
      .where('message_id', '=', outcome.messageId)
      .where('state', 'in', UNRATED_REASONS)
      .execute();
    return this.insertOutcome(outcome);
  }

  /** Which orgs have unrated cost rows — retried hourly against whatever cards are live now. */
  async orgsWithUnratedOutcomes(): Promise<string[]> {
    const rows = await sql<{ org_id: string }>`
      SELECT DISTINCT org_id FROM commerce_message_costs WHERE state LIKE 'unrated_%'
    `.execute(db);
    return rows.rows.map((row) => row.org_id);
  }

  /** Which orgs have receipts awaiting rating — the backfill sweep's candidate list. */
  async orgsWithReceiptsAwaitingRating(): Promise<string[]> {
    const rows = await sql<{ org_id: string }>`
      SELECT DISTINCT m.org_id
      FROM commerce_messages m
      WHERE m.billable IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM commerce_message_costs c WHERE c.message_id = m.id)
    `.execute(db);
    return rows.rows.map((row) => row.org_id);
  }
}

export const messageCostRepository = new MessageCostRepository();
