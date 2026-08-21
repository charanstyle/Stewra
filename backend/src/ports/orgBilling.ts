/**
 * Whether an organization is still being billed, asked from outside the commerce plane.
 *
 * Same shape and same reason as `orgInviteEmail.ts` and `turnIntent.ts` next door, in the other
 * direction: `.dependency-cruiser.cjs` forbids anything outside `backend/src/commerce/` from
 * importing it, and account deletion — a personal-assistant service — has one honest question for
 * the commerce plane before it destroys an org.
 *
 * That question is deliberately NOT "list the subscription rows". Which store statuses still take
 * money is a commerce fact that changes when Apple or Google changes its lifecycle, and a copy of
 * that set living in a deletion service would drift silently into telling people they are not being
 * charged when they are. So the port asks the plane that owns the answer, and gets back only what the
 * warning needs to say.
 */
export interface OngoingOrgBilling {
  /** Which store keeps charging — the word shown to the user, e.g. `apple` or `google`. */
  readonly store: string;
}

export interface OrgBillingReader {
  /**
   * Subscriptions that would keep taking money if this org went away, or an empty array.
   *
   * THROWS rather than returning empty when it cannot tell. An empty array is read by the caller as
   * "nothing will charge you", and printing that on a permanent-deletion screen because a query
   * failed is worse than showing the user an error they can retry.
   */
  listOngoing(orgId: string): Promise<OngoingOrgBilling[]>;
}

class OrgBillingRegistry {
  private reader: OrgBillingReader | null = null;

  register(reader: OrgBillingReader): void {
    this.reader = reader;
  }

  /** For tests that need to swap in a scripted reader. */
  reset(): void {
    this.reader = null;
  }

  /**
   * The reader, or a thrown error naming why there is none. Deliberately not a null-and-skip: with
   * no reader there is no way to distinguish "this org has no subscription" from "nobody wired the
   * commerce plane into this process", and the deletion is irreversible either way.
   */
  require(): OrgBillingReader {
    if (this.reader === null) {
      throw new Error(
        'No org-billing reader is registered — the commerce plane is not wired into this process, ' +
          'so whether this organization is still being charged cannot be established.',
      );
    }
    return this.reader;
  }
}

export const orgBillingRegistry = new OrgBillingRegistry();
