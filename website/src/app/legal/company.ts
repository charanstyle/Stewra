/**
 * The identity behind Stewra, in one place because it appears in three: the privacy policy, the
 * terms, and Meta's Embedded Signup consent dialog — where a client sees the business portfolio
 * name next to the app name and has to decide whether to trust it.
 *
 * `CONTACT_EMAIL` MUST be a mailbox somebody actually reads. UK GDPR requires a working contact
 * point for data-subject requests, and Meta's App Review sends a reviewer to the privacy policy and
 * expects the contact route on it to be real. A bounced address here is a rejection and, separately,
 * a compliance failure.
 */
export const COMPANY_NAME = 'Nurturing Lab Limited Company';

export const PRODUCT_NAME = 'Stewra';

export const CONTACT_EMAIL = 'privacy@stewra.com';

/** Bump both documents together — a policy whose date predates a material change is worse than none. */
export const LAST_UPDATED = '4 August 2026';
