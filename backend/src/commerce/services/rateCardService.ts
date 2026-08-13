import type {
  CommerceMessageRate,
  CommerceRateCard,
  MessagePricingCategory,
  RateUnit,
} from '@stewra/shared-types';
import { rateCardRepository } from '../repositories/rateCardRepository.js';
import { isCallingCode } from './callingCodes.js';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';

/**
 * Loading and reading the operator's price list.
 *
 * The zod schema at the controller has already established SHAPE (a currency-looking string, a
 * digits-only micros string, members of the closed unions). What this layer establishes is TRUTH
 * against data the schema cannot see: the calling codes are assigned ones, the load does not
 * contradict itself, and the new card's era begins after the era it supersedes.
 */
class RateCardService {
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
    const details: Array<{ field: string; message: string }> = [];

    // A card with no rates would be a live era in which every message is unrated — loadable only
    // by mistake, so refuse it rather than let one typo of a request body silence a month's rating.
    if (params.rates.length === 0) {
      details.push({ field: 'rates', message: 'A rate card must carry at least one rate.' });
    }

    const seen = new Set<string>();
    params.rates.forEach((rate, index) => {
      if (!isCallingCode(rate.countryCallingCode)) {
        details.push({
          field: `rates.${index}.countryCallingCode`,
          message: `'${rate.countryCallingCode}' is not an assigned E.164 calling code.`,
        });
      }
      // Duplicates are refused here with the row numbers named, rather than left to the unique
      // constraint, whose error can only point at one row of a 300-row load.
      const key = `${rate.countryCallingCode}:${rate.pricingCategory}`;
      if (seen.has(key)) {
        details.push({
          field: `rates.${index}`,
          message: `Duplicate rate for calling code ${rate.countryCallingCode}, category ${rate.pricingCategory}.`,
        });
      }
      seen.add(key);
    });
    if (details.length > 0) {
      throw new ValidationError('Validation failed', details);
    }

    // The new era must begin strictly after the live one did: closing the live card stamps its
    // effective_to with this effectiveFrom, and an equal or earlier instant would rewrite history
    // that messages may already have been rated against. 409 rather than 400 because the request
    // is well-formed — it conflicts with what has already been loaded.
    const live = await rateCardRepository.findLive(params.currency);
    if (live !== null && params.effectiveFrom.getTime() <= new Date(live.effectiveFrom).getTime()) {
      throw new ConflictError(
        `The live ${params.currency} card is effective from ${live.effectiveFrom}; a new card must ` +
          'take effect strictly after that. Rated messages are never re-rated — a correction takes ' +
          'effect from now, not retroactively.',
      );
    }

    return rateCardRepository.loadCard(params);
  }

  async listCards(): Promise<CommerceRateCard[]> {
    return rateCardRepository.listCards();
  }

  async getCard(cardId: string): Promise<{ card: CommerceRateCard; rates: CommerceMessageRate[] }> {
    const card = await rateCardRepository.findCard(cardId);
    if (card === null) {
      throw new NotFoundError('Rate card not found');
    }
    return { card, rates: await rateCardRepository.listRates(cardId) };
  }
}

export const rateCardService = new RateCardService();
