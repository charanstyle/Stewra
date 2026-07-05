/**
 * Password-reset contract. A logged-OUT user who forgot their password proves control of their email
 * with a short-lived numeric code (the same single-use, attempt-limited mechanism as email
 * verification) and sets a new password. Two steps: request a code, then confirm the code + new
 * password. Responses are deliberately generic — they never reveal whether an email is registered.
 */

/**
 * Length of the numeric reset code. Single source of truth shared by the client form validator and the
 * server generator/validator so the two can never drift. Matches the verification code length.
 */
export const PASSWORD_RESET_CODE_LENGTH = 6;

/** Minimum length of a new password (mirrors the register form's rule). */
export const PASSWORD_RESET_MIN_PASSWORD_LENGTH = 8;

/** Ask that a reset code be emailed to this address (subject to a per-account cooldown). */
export interface RequestPasswordResetRequest {
  readonly email: string;
}

/**
 * Always-generic acknowledgement. `ok` is true whether or not the email belonged to an account, so the
 * endpoint can't be used to enumerate registered addresses.
 */
export interface RequestPasswordResetResponse {
  readonly ok: true;
}

/** Submit the emailed code together with the new password to complete the reset. */
export interface ConfirmPasswordResetRequest {
  readonly email: string;
  readonly code: string;
  readonly newPassword: string;
}

export interface ConfirmPasswordResetResponse {
  readonly ok: true;
}
