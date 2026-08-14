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
    // Everything is still reported — but a 400 from a bad request body is not the same event as a
    // 500, and until now they arrived identically. That is not merely noisy: an alert rule that
    // fires on a steady drizzle of validation errors is one people learn to ignore, and the real
    // fault then lands in a stream nobody reads. So client errors go at `warning`: they stop
    // paging, and they stay searchable, which is the half that matters when 400s on one route
    // suddenly multiply after a deploy.
    //
    // A non-AppError has no status of its own; it becomes the 500 rendered below, so it is an
    // error by definition.
    const statusCode = error instanceof AppError ? error.statusCode : 500;
    Sentry.captureException(error, {
      level: statusCode >= 500 ? 'error' : 'warning',
      tags: { surface: 'controller', http_status: String(statusCode) },
      extra: { context },
    });

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
