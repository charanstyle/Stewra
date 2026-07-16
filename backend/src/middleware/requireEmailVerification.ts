import type { NextFunction, Request, Response } from 'express';
import { userRepository } from '../repositories/userRepository.js';
import { ForbiddenError } from '../utils/errors.js';

/**
 * Gate for features that must wait until the user has confirmed their email. Runs AFTER requireAuth
 * (relies on req.userId). A distinct error code lets the website route the user to the verify screen
 * rather than showing a generic "forbidden". This is a control-plane guard — no agent involvement.
 */
export async function requireEmailVerification(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = req.userId;
    if (userId === undefined) {
      throw new Error('requireEmailVerification must run after requireAuth');
    }
    const user = await userRepository.findById(userId);
    if (!user) {
      throw new ForbiddenError('Account not found.', 'EMAIL_NOT_VERIFIED');
    }
    if (!user.email_verified) {
      throw new ForbiddenError('Verify your email to use this feature.', 'EMAIL_NOT_VERIFIED');
    }
    next();
  } catch (error) {
    next(error);
  }
}
