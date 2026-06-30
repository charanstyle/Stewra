import type { User } from '../models/user';
import type { ISODateString } from '../common/base';

/**
 * Length of the numeric email-verification code. Single source of truth shared by the client form
 * validator and the server generator/validator, so the two can never drift.
 */
export const EMAIL_VERIFICATION_CODE_LENGTH = 6;

/** Submit the code from the verification email to mark the account verified. */
export interface VerifyEmailRequest {
  readonly code: string;
}

export interface VerifyEmailResponse {
  /** The freshly-verified user (`emailVerified === true`). */
  readonly user: User;
}

/** Request that a fresh code be emailed (subject to the resend cooldown). */
export interface ResendVerificationResponse {
  /** When the newly-issued code expires. */
  readonly expiresAt: ISODateString;
}
