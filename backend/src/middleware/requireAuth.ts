import type { NextFunction, Request, Response } from 'express';
import { authService } from '../services/authService';
import { AuthenticationError } from '../utils/errors';

/** Requires a valid access token. Sets req.userId on success; otherwise passes an error onward. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (header === undefined || !header.startsWith('Bearer ')) {
    next(new AuthenticationError('Missing or malformed Authorization header'));
    return;
  }
  const token = header.slice('Bearer '.length).trim();
  try {
    req.userId = authService.verifyToken(token, 'access');
    next();
  } catch (error) {
    next(error);
  }
}
