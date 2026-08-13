import type { Selectable } from 'kysely';
import type {
  CommerceMessageRate,
  CommerceRateCard,
  MessagePricingCategory,
  RateUnit,
} from '@stewra/shared-types';
import { db } from '../../database/index.js';
import type { CommerceRateCardsTable } from '../../database/types.js';

function toCard(row: Selectable<CommerceRateCardsTable>, rateCount: number): CommerceRateCard {
  return {
    id: row.id,
    currency: row.currency,
    effectiveFrom: row.effective_from.toISOString(),
    effectiveTo: row.effective_to?.toISOString() ?? null,
    sourceNote: row.source_note,
    loadedByUserId: row.loaded_by_user_id,
    rateCount,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * The operator's price list. Platform data: nothing here takes an `orgId`, and nothing here may
 * ever be reachable from an `/orgs` route — a client must never edit the price they are billed at.
 *
 * Writes are append-and-close only, and the triggers from migration 050 enforce that below any bug
 * in this file. Amounts stay `bigint` from the moment they are parsed to the moment they are
 * written; pg returns int8 as a string and callers convert with `BigInt()`, never `Number()`.
 */
class RateCardRepository {
  /**
   * Load a new card and its rates, closing the currency's live card in the same transaction.
   *
   * The close uses the new card's `effective_from` as the old card's `effective_to`, so the
   * currency's timeline has no gap and no overlap — the invariant `resolveRate` depends on to
   * return at most one card for any instant. The caller has already verified the new
   * `effectiveFrom` is after the live card's; the CHECK constraint refuses anything that would
   * make a closed card's window empty or inverted, and the partial unique index makes one of two
   * concurrent loads lose at the database rather than both becoming live.
   */
  async loadCard(params: {
    currency: string;
    effectiveFrom: Date;
    sourceNote: string;
    loadedByUserId: string;
    rates: ReadonlyArray<{
      countryCallingCode: string;
      pricingCategory: MessagePricingCategory;
      amountMicros: bigint;
      unit: RateUnit;
    }>;
  }): Promise<CommerceRateCard> {
    const row = await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('commerce_rate_cards')
        .set({ effective_to: params.effectiveFrom })
        .where('currency', '=', params.currency)
        .where('effective_to', 'is', null)
        .execute();

      const card = await trx
        .insertInto('commerce_rate_cards')
        .values({
          currency: params.currency,
          effective_from: params.effectiveFrom,
          source_note: params.sourceNote,
          loaded_by_user_id: params.loadedByUserId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('commerce_message_rates')
        .values(
          params.rates.map((rate) => ({
            rate_card_id: card.id,
            country_calling_code: rate.countryCallingCode,
            pricing_category: rate.pricingCategory,
            amount_micros: rate.amountMicros.toString(),
            unit: rate.unit,
          })),
        )
        .execute();

      return card;
    });
    return toCard(row, params.rates.length);
  }

  /** The live card for a currency, or null. The thing a load supersedes and a rater resolves from. */
  async findLive(currency: string): Promise<CommerceRateCard | null> {
    const row = await db
      .selectFrom('commerce_rate_cards')
      .selectAll()
      .where('currency', '=', currency)
      .where('effective_to', 'is', null)
      .executeTakeFirst();
    return row === undefined ? null : toCard(row, await this.countRates(row.id));
  }

  /** Every card ever loaded, newest era first, each with its rate count. */
  async listCards(): Promise<CommerceRateCard[]> {
    const rows = await db
      .selectFrom('commerce_rate_cards')
      .selectAll('commerce_rate_cards')
      .select((eb) =>
        eb
          .selectFrom('commerce_message_rates')
          .select(({ fn }) => fn.countAll<string>().as('count'))
          .whereRef('commerce_message_rates.rate_card_id', '=', 'commerce_rate_cards.id')
          .as('rate_count'),
      )
      .orderBy('currency', 'asc')
      .orderBy('effective_from', 'desc')
      .execute();
    return rows.map((row) => toCard(row, Number(row.rate_count ?? 0)));
  }

  async findCard(cardId: string): Promise<CommerceRateCard | null> {
    const row = await db
      .selectFrom('commerce_rate_cards')
      .selectAll()
      .where('id', '=', cardId)
      .executeTakeFirst();
    return row === undefined ? null : toCard(row, await this.countRates(cardId));
  }

  /** A card's full price list, ordered the way Meta's sheet reads: by country, then category. */
  async listRates(cardId: string): Promise<CommerceMessageRate[]> {
    const rows = await db
      .selectFrom('commerce_message_rates')
      .select(['country_calling_code', 'pricing_category', 'amount_micros', 'unit'])
      .where('rate_card_id', '=', cardId)
      .orderBy('country_calling_code', 'asc')
      .orderBy('pricing_category', 'asc')
      .execute();
    return rows.map((row) => ({
      countryCallingCode: row.country_calling_code,
      pricingCategory: row.pricing_category,
      amountMicros: row.amount_micros,
      unit: row.unit,
    }));
  }

  /**
   * The price for one message: the card live at `at` for `currency`, and its rate for the
   * message's country and category. Null when either half is missing — the caller records
   * `unrated_no_rate` and the message stays visibly unpriced. There is deliberately no fallback:
   * a missing rate is a gap on a report, not a guess on an invoice.
   */
  async resolveRate(params: {
    currency: string;
    at: Date;
    countryCallingCode: string;
    pricingCategory: MessagePricingCategory;
  }): Promise<{ rateCardId: string; amountMicros: bigint; unit: RateUnit } | null> {
    const row = await db
      .selectFrom('commerce_rate_cards')
      .innerJoin(
        'commerce_message_rates',
        'commerce_message_rates.rate_card_id',
        'commerce_rate_cards.id',
      )
      .select([
        'commerce_rate_cards.id as rate_card_id',
        'commerce_message_rates.amount_micros',
        'commerce_message_rates.unit',
      ])
      .where('commerce_rate_cards.currency', '=', params.currency)
      .where('commerce_rate_cards.effective_from', '<=', params.at)
      .where((eb) =>
        eb.or([
          eb('commerce_rate_cards.effective_to', 'is', null),
          eb('commerce_rate_cards.effective_to', '>', params.at),
        ]),
      )
      .where('commerce_message_rates.country_calling_code', '=', params.countryCallingCode)
      .where('commerce_message_rates.pricing_category', '=', params.pricingCategory)
      .executeTakeFirst();
    if (row === undefined) return null;
    return {
      rateCardId: row.rate_card_id,
      amountMicros: BigInt(row.amount_micros),
      unit: row.unit,
    };
  }

  private async countRates(cardId: string): Promise<number> {
    const counted = await db
      .selectFrom('commerce_message_rates')
      .select(({ fn }) => fn.countAll<string>().as('count'))
      .where('rate_card_id', '=', cardId)
      .executeTakeFirst();
    return Number(counted?.count ?? 0);
  }
}

export const rateCardRepository = new RateCardRepository();
