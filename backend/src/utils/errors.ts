/** Operational error hierarchy. Controllers throw these; the error middleware renders them. */
export abstract class AppError extends Error {
  abstract readonly statusCode: number;
  abstract readonly code: string;
  readonly isOperational = true;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends AppError {
  readonly statusCode = 400;
  readonly code = 'VALIDATION_ERROR';
  readonly details: ReadonlyArray<{ field: string; message: string }>;

  constructor(message: string, details: ReadonlyArray<{ field: string; message: string }> = []) {
    super(message);
    this.details = details;
  }
}

export class AuthenticationError extends AppError {
  readonly statusCode = 401;
  readonly code = 'AUTHENTICATION_ERROR';
}

export class ConflictError extends AppError {
  readonly statusCode = 409;
  readonly code = 'CONFLICT';
}

export class NotFoundError extends AppError {
  readonly statusCode = 404;
  readonly code = 'NOT_FOUND';
}

/** Authenticated but not allowed — e.g. trying to use a gated feature before verifying email. */
export class ForbiddenError extends AppError {
  readonly statusCode = 403;
  readonly code: string;

  constructor(message: string, code = 'FORBIDDEN') {
    super(message);
    this.code = code;
  }
}

/** Too many attempts / too soon — used for the verify lockout and the resend cooldown. */
export class RateLimitError extends AppError {
  readonly statusCode = 429;
  readonly code = 'RATE_LIMITED';
}
