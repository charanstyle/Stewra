import type { Request, Response } from 'express';
import { z } from 'zod';
import type {
  GetRateCardResponse,
  ListRateCardsResponse,
  LoadRateCardResponse,
} from '@stewra/shared-types';
import { MESSAGE_PRICING_CATEGORIES, RATE_UNITS } from '@stewra/shared-types';
import { BaseController } from '../../controllers/baseController.js';
import { rateCardService } from '../services/rateCardService.js';
import { parse } from '../../utils/validate.js';
import { AuthenticationError } from '../../utils/errors.js';

const loadRateCardSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/, 'currency must be an uppercase ISO 4217 code'),
  effectiveFrom: z.string().datetime({ offset: true }),
  sourceNote: z.string().min(1).max(2000),
  rates: z
    .array(
      z.object({
        countryCallingCode: z.string().regex(/^\d{1,3}$/),
        pricingCategory: z.enum(MESSAGE_PRICING_CATEGORIES),
        // A decimal string, never a JSON number: the value is a bigint and a number would have
        // already been rounded by the time zod saw it. 15 digits is a billion currency units in
        // micros — anything longer is a pasted mistake, not a price.
        amountMicros: z.string().regex(/^\d{1,15}$/, 'amountMicros must be a digits-only string'),
        unit: z.enum(RATE_UNITS),
      }),
    )
    .max(5000),
});

/**
 * The platform-operator surface for the price list. Mounted at `/platform/rate-cards` behind
 * `requireInstallAdmin` — deliberately NOT under `/orgs/:orgId` and never behind
 * `requireOrgMember`, because a client must not edit the price they are billed at.
 */
class RateCardsController extends BaseController {
  /** POST /platform/rate-cards */
  async load(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.userId;
      if (userId === undefined) {
        throw new AuthenticationError('Route is missing requireAuth');
      }
      const body = parse(loadRateCardSchema, req.body);
      const card = await rateCardService.loadCard({
        currency: body.currency,
        effectiveFrom: new Date(body.effectiveFrom),
        sourceNote: body.sourceNote,
        loadedByUserId: userId,
        rates: body.rates.map((rate) => ({
          countryCallingCode: rate.countryCallingCode,
          pricingCategory: rate.pricingCategory,
          amountMicros: BigInt(rate.amountMicros),
          unit: rate.unit,
        })),
      });
      const response: LoadRateCardResponse = { card };
      this.handleSuccess(res, response, 201);
    } catch (error) {
      this.handleError(error, res, 'RateCardsController.load');
    }
  }

  /** GET /platform/rate-cards */
  async list(_req: Request, res: Response): Promise<void> {
    try {
      const cards = await rateCardService.listCards();
      const response: ListRateCardsResponse = { cards };
      this.handleSuccess(res, response);
    } catch (error) {
      this.handleError(error, res, 'RateCardsController.list');
    }
  }

  /** GET /platform/rate-cards/:cardId */
  async get(req: Request, res: Response): Promise<void> {
    try {
      const params = parse(z.object({ cardId: z.string().uuid() }), req.params);
      const { card, rates } = await rateCardService.getCard(params.cardId);
      const response: GetRateCardResponse = { card, rates };
      this.handleSuccess(res, response);
    } catch (error) {
      this.handleError(error, res, 'RateCardsController.get');
    }
  }
}

export const rateCardsController = new RateCardsController();
