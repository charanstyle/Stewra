import type { Response } from 'express';
import * as Sentry from '@sentry/node';
import type { ApiResponse } from '@stewra/shared-types';
import { AppError, ValidationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/** Base for all controllers: uniform success/error rendering, with Sentry capture on failure. */
export abstract class BaseController {
  protected handleSuccess<T>(res: Response, data: T, statusCode = 200): void {
    const body: ApiResponse<T> = { success: true, data };
    res.status(statusCode).json(body);
  }

  protected handleError(error: unknown, res: Response, context: string): void {
    Sentry.captureException(error);

    if (error instanceof AppError) {
      const details =
        error instanceof ValidationError
          ? error.details.map((d) => ({ field: d.field, message: d.message }))
          : [];
      const body: ApiResponse<never> = {
        success: false,
        error: { code: error.code, message: error.message, details },
      };
      res.status(error.statusCode).json(body);
      return;
    }

    logger.error('Unhandled error in controller', {
      context,
      error: error instanceof Error ? error.message : String(error),
    });
    const body: ApiResponse<never> = {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong', details: [] },
    };
    res.status(500).json(body);
  }
}
