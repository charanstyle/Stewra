import type { OrgRole, RunnerDeviceKind } from '@stewra/shared-types';

// Augments Express's Request with the authenticated user id set by requireAuth.
// Optional because it is only present after the requireAuth middleware runs.
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      /**
       * The runner device behind a device-token-authenticated request, set by `requireRunnerDevice`.
       * A SEPARATE field from `userId` on purpose: these two authentications are not interchangeable,
       * and a route that meant to require a human must never be satisfied by a runner's token because
       * both happened to populate the same property.
       */
      runnerDevice?: {
        readonly deviceId: string;
        readonly userId: string;
        readonly kind: RunnerDeviceKind;
      };
      /**
       * The commerce-plane tenant this request acts on, set by `requireOrgMember` after it has
       * verified the caller's membership and minimum role.
       *
       * A SEPARATE field from `userId` for the same reason `runnerDevice` is: being signed in says
       * nothing about which organization's data you may touch. A commerce repository that reads
       * `userId` instead of `orgId` is a tenancy bug, so the two never share a property.
       */
      org?: {
        readonly orgId: string;
        readonly role: OrgRole;
      };
    }
  }
}

export {};
