import { randomInt } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { PASSWORD_RESET_CODE_LENGTH, PASSWORD_RESET_MIN_PASSWORD_LENGTH } from '@stewra/shared-types';
import { config } from '../config/unifiedConfig.js';
import { RateLimitError, ValidationError } from '../utils/errors.js';
import { passwordResetRepository } from '../repositories/passwordResetRepository.js';
import { userRepository } from '../repositories/userRepository.js';
import { emailService } from './emailService.js';
import { auditWriter } from '../control-plane/audit/auditWriter.js';
import { logger } from '../utils/logger.js';

/** A wrong code and a nonexistent account return the SAME message so neither reveals the other. */
const GENERIC_CODE_ERROR = 'That code is invalid or has expired. Request a new one.';

function generateCode(): string {
  const min = 10 ** (PASSWORD_RESET_CODE_LENGTH - 1);
  const max = 10 ** PASSWORD_RESET_CODE_LENGTH;
  return String(randomInt(min, max));
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Password reset for a LOGGED-OUT user. The user proves control of their email with a short-lived,
 * single-use, attempt-limited numeric code (the same mechanism as email verification) and sets a new
 * password. Every externally observable outcome is deliberately independent of whether an email is
 * registered, so the endpoints can't be used to enumerate accounts. Control-plane code (not the agent):
 * it writes the `auth.password_reset` audit row itself.
 */
export class PasswordResetService {
  /**
   * Issue a reset code for `email` and send it — but ONLY if that email belongs to an account and the
   * per-account cooldown has elapsed. Returns nothing and never signals which of those was true: the
   * caller always sees a generic success.
   */
  async request(emailRaw: string): Promise<void> {
    const email = normalizeEmail(emailRaw);
    const user = await userRepository.findByEmail(email);
    if (!user) {
      // Unknown address: do nothing, but return as if we had (no enumeration signal).
      return;
    }

    // Silently respect the cooldown too — surfacing a "wait Ns" error would leak that the email exists.
    const latest = await passwordResetRepository.latestForUser(user.id);
    if (latest) {
      const elapsedMs = Date.now() - latest.created_at.getTime();
      if (elapsedMs < config.passwordReset.resendCooldownSeconds * 1000) {
        return;
      }
    }

    const code = generateCode();
    const expiresAt = new Date(Date.now() + config.passwordReset.ttlMinutes * 60_000);
    await passwordResetRepository.markActiveUsed(user.id);
    await passwordResetRepository.create({ userId: user.id, code, email: user.email, expiresAt });
    try {
      await emailService.sendPasswordResetCode(user.email, code, config.passwordReset.ttlMinutes);
    } catch (error) {
      // A send failure must not leak existence via an error response; log for triage and stay generic.
      logger.error('Failed to send password reset email', {
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Verify the submitted code for `email` and, on success, set the new password. Wrong code / unknown
   * account / expiry all collapse to the same generic error; the attempt cap and expiry are enforced
   * exactly as in email verification.
   */
  async confirm(emailRaw: string, submittedCode: string, newPassword: string): Promise<void> {
    // Validate the new password BEFORE touching the code, so a too-short password never burns an attempt.
    if (newPassword.length < PASSWORD_RESET_MIN_PASSWORD_LENGTH) {
      throw new ValidationError(
        `Your new password must be at least ${PASSWORD_RESET_MIN_PASSWORD_LENGTH} characters.`,
      );
    }

    const email = normalizeEmail(emailRaw);
    const user = await userRepository.findByEmail(email);
    if (!user) {
      throw new ValidationError(GENERIC_CODE_ERROR);
    }

    const active = await passwordResetRepository.latestActiveForUser(user.id);
    if (!active) {
      throw new ValidationError(GENERIC_CODE_ERROR);
    }
    if (active.expires_at.getTime() < Date.now()) {
      await passwordResetRepository.markUsed(active.id);
      throw new ValidationError(GENERIC_CODE_ERROR);
    }
    if (active.attempts >= config.passwordReset.maxAttempts) {
      await passwordResetRepository.markUsed(active.id);
      throw new RateLimitError('Too many attempts. Request a new code.');
    }
    if (submittedCode !== active.code) {
      await passwordResetRepository.incrementAttempts(active.id);
      const remaining = config.passwordReset.maxAttempts - (active.attempts + 1);
      if (remaining <= 0) {
        await passwordResetRepository.markUsed(active.id);
        throw new RateLimitError('Too many attempts. Request a new code.');
      }
      throw new ValidationError(
        `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} left.`,
      );
    }

    // Correct code: consume it, burn any siblings, set the new password, and record the event.
    await passwordResetRepository.markUsed(active.id);
    await passwordResetRepository.markActiveUsed(user.id);
    const passwordHash = await bcrypt.hash(newPassword, config.auth.bcryptRounds);
    await userRepository.updatePasswordHash(user.id, passwordHash);
    await auditWriter.write({
      userId: user.id,
      action: 'auth.password_reset',
      resourceType: 'auth',
      resourceId: user.id,
      summary: 'You reset your password.',
      success: true,
      metadata: {},
    });
  }
}

export const passwordResetService = new PasswordResetService();
