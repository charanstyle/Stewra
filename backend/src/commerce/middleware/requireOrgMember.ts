import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { OrgRole } from '@stewra/shared-types';
import { roleMeetsMinimum } from '@stewra/shared-types';
import { organizationRepository } from '../repositories/organizationRepository.js';
import { AuthenticationError, ForbiddenError, NotFoundError } from '../../utils/errors.js';

/**
 * THE tenancy choke point for the commerce plane. Every `/orgs/:orgId/...` route runs this, and
 * every commerce repository beneath it scopes on `org_id` alone, trusting that this already ran.
 *
 * Three things happen here, in order, and the order matters:
 *
 *  1. There must be an authenticated caller. `requireAuth` runs first and sets `req.userId`; if it
 *     somehow did not, this throws rather than treating "no user" as "no membership" — a missing
 *     authentication is a wiring bug, not a permission answer.
 *  2. The caller must be a member. A non-member gets **404, not 403** — see below.
 *  3. Their role must meet `minimum`. A member with too little privilege DOES get 403, because they
 *     already know the organization exists.
 *
 * Why 404 for a non-member: 403 confirms the org id is real. An attacker enumerating uuids would
 * learn which ones exist, and org ids appear in invite links and shared URLs. `findMembership`
 * returns null for both "no such org" and "not your org" precisely so this layer cannot tell them
 * apart and therefore cannot leak the difference.
 *
 * A suspended organization is refused for everyone. Letting a suspended tenant keep sending is how
 * a billing hold or an abuse suspension becomes decorative.
 */
export function requireOrgMember(minimum: OrgRole): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    // `next()` is deliberately called OUTSIDE the promise's catch: it runs the rest of the stack
    // synchronously, and a downstream throw landing in this catch would call next() a second time.
    resolveOrg(req, minimum).then(() => {
      next();
    }, next);
  };
}

async function resolveOrg(req: Request, minimum: OrgRole): Promise<void> {
  const userId = req.userId;
  if (userId === undefined) {
    throw new AuthenticationError('requireOrgMember used without requireAuth');
  }

  const orgId = req.params['orgId'];
  if (orgId === undefined || orgId.length === 0) {
    throw new NotFoundError('Organization not found');
  }

  const membership = await organizationRepository.findMembership(userId, orgId);
  if (membership === null) {
    throw new NotFoundError('Organization not found');
  }

  if (membership.org.status === 'suspended') {
    throw new ForbiddenError('This organization is suspended.', 'ORGANIZATION_SUSPENDED');
  }

  if (!roleMeetsMinimum(membership.role, minimum)) {
    throw new ForbiddenError(
      `This action requires the ${minimum} role or above.`,
      'INSUFFICIENT_ORG_ROLE',
    );
  }

  req.org = { orgId, role: membership.role };
}

/**
 * Read the tenant a handler is acting on. Throws rather than returning undefined: a commerce
 * controller reached without `requireOrgMember` is an unscoped query waiting to happen, and it must
 * fail loudly at the first call rather than quietly read across tenants.
 */
export function orgContext(req: Request): { orgId: string; role: OrgRole } {
  const org = req.org;
  if (org === undefined) {
    throw new AuthenticationError('Route is missing requireOrgMember');
  }
  return org;
}
