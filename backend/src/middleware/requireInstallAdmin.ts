import type { NextFunction, Request, Response } from 'express';
import { config } from '../config/unifiedConfig.js';
import { userRepository } from '../repositories/userRepository.js';
import { AuthenticationError, NotFoundError } from '../utils/errors.js';

/**
 * Gate for platform-operator surfaces — the routes that belong to whoever RUNS this install, not to
 * any organization on it. Today that is the rate-card loader: the table of prices every org is
 * billed from, which is exactly the thing no org member, owner included, may ever touch.
 *
 * Membership is by account email, named in INSTALL_ADMIN_EMAILS. The list defaults to empty, and
 * empty means NOBODY — the gate fails closed on an install that has not named its operators,
 * rather than open on one that forgot the var.
 *
 * A non-operator gets **404, not 403**, for the same reason `requireOrgMember` gives non-members
 * 404: a 403 confirms the surface exists. To every account not on the list, `/platform/...` looks
 * exactly like a route that was never mounted.
 *
 * Runs AFTER requireAuth (relies on req.userId), and checks `email_verified` itself: operator
 * power must not attach to an address nobody has proven they control, and this guard being
 * self-contained means a route cannot weaken it by forgetting the verification middleware.
 */
export async function requireInstallAdmin(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = req.userId;
    if (userId === undefined) {
      throw new AuthenticationError('requireInstallAdmin used without requireAuth');
    }
    const user = await userRepository.findById(userId);
    if (
      !user ||
      !user.email_verified ||
      !config.installAdmins.includes(user.email.toLowerCase())
    ) {
      throw new NotFoundError('Not found');
    }
    next();
  } catch (error) {
    next(error);
  }
}
