import type { NextFunction, Request, Response } from 'express';
import * as Sentry from '@sentry/node';
import type { ApiResponse } from '@stewra/shared-types';
import { AppError, ValidationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export function notFoundHandler(_req: Request, res: Response): void {
  const body: ApiResponse<never> = {
    success: false,
    error: { code: 'NOT_FOUND', message: 'Route not found', details: [] },
  };
  res.status(404).json(body);
}

/** Terminal error middleware. Renders AppError; captures everything else to Sentry as a 500. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    const details =
      err instanceof ValidationError ? err.details.map((d) => ({ field: d.field, message: d.message })) : [];
    const body: ApiResponse<never> = {
      success: false,
      error: { code: err.code, message: err.message, details },
    };
    res.status(err.statusCode).json(body);
    return;
  }

  Sentry.captureException(err);
  logger.error('Unhandled error', { error: err instanceof Error ? err.message : String(err) });
  const body: ApiResponse<never> = {
    success: false,
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong', details: [] },
  };
  res.status(500).json(body);
}
