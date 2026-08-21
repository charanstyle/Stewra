import type { OngoingOrgBilling, OrgBillingReader } from '../../ports/orgBilling.js';
import { storeSubscriptionRepository } from '../repositories/storeSubscriptionRepository.js';

/**
 * Store-subscription statuses that mean the org is still being billed by Apple or Google.
 *
 * `pending` is in the list on purpose: a purchase the store has not finished processing can still
 * become a charge, so it is exactly the case a warning must not omit.
 *
 * This set lives here, in the commerce plane, and NOT in the account-deletion service that asks the
 * question — the store lifecycle is this plane's to know, and the service on the other side of
 * `ports/orgBilling` only ever sees the answer.
 */
const BILLING_STORE_STATUSES: ReadonlySet<string> = new Set([
  'active',
  'grace_period',
  'pending',
  'on_hold',
]);

/** The commerce plane's answer to "is this org still being charged?", registered by `app.ts`. */
export const orgBillingReader: OrgBillingReader = {
  async listOngoing(orgId: string): Promise<OngoingOrgBilling[]> {
    const subs = await storeSubscriptionRepository.listForOrg(orgId);
    return subs
      .filter((sub) => BILLING_STORE_STATUSES.has(sub.status))
      .map((sub) => ({ store: sub.store }));
  },
};
