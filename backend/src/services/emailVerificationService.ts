import { randomInt } from 'node:crypto';
import { EMAIL_VERIFICATION_CODE_LENGTH } from '@stewra/shared-types';
import type { User } from '@stewra/shared-types';
import { config } from '../config/unifiedConfig';
import { ConflictError, NotFoundError, RateLimitError, ValidationError } from '../utils/errors';
import { emailVerificationRepository } from '../repositories/emailVerificationRepository';
import { userRepository, toUserModel } from '../repositories/userRepository';
import { emailService } from './emailService';
import { auditWriter } from '../control-plane/audit/auditWriter';

/**
 * Generate a uniformly-random numeric code with no leading-zero loss. `randomInt` (CSPRNG) over
 * [10^(n-1), 10^n) always yields exactly n digits — stronger than Math.random and never short.
 */
function generateCode(): string {
  const min = 10 ** (EMAIL_VERIFICATION_CODE_LENGTH - 1);
  const max = 10 ** EMAIL_VERIFICATION_CODE_LENGTH;
  return String(randomInt(min, max));
}

/**
 * Owns the verification lifecycle. NOT part of the agent plane — it's control-plane code that the
 * control plane (not the agent) uses to write the `verify` audit row. Codes are bound to the user,
 * single-use, time-boxed, and attempt-limited; this service is where all three are enforced.
 */
export class EmailVerificationService {
  /** Issue a fresh code: burn any outstanding one, store the new one, email it. Returns its expiry. */
  async issue(userId: string, email: string): Promise<Date> {
    const code = generateCode();
    const expiresAt = new Date(Date.now() + config.emailVerification.ttlMinutes * 60_000);
    await emailVerificationRepository.markActiveUsed(userId);
    await emailVerificationRepository.create({ userId, code, email, expiresAt });
    await emailService.sendVerificationCode(email, code, config.emailVerification.ttlMinutes);
    return expiresAt;
  }

  /** Re-issue a code, enforcing the per-user cooldown. */
  async resend(userId: string): Promise<Date> {
    const user = await userRepository.findById(userId);
    if (!user) {
      throw new NotFoundError('User not found');
    }
    if (user.email_verified) {
      throw new ConflictError('Your email is already verified.');
    }
    const latest = await emailVerificationRepository.latestForUser(userId);
    if (latest) {
      const elapsedMs = Date.now() - latest.created_at.getTime();
      const cooldownMs = config.emailVerification.resendCooldownSeconds * 1000;
      if (elapsedMs < cooldownMs) {
        const wait = Math.ceil((cooldownMs - elapsedMs) / 1000);
        throw new RateLimitError(`Please wait ${wait}s before requesting another code.`);
      }
    }
    return this.issue(userId, user.email);
  }

  /** Check a submitted code. Enforces expiry + the attempts-then-lockout cap. Returns the verified user. */
  async verify(userId: string, submitted: string): Promise<User> {
    const user = await userRepository.findById(userId);
    if (!user) {
      throw new NotFoundError('User not found');
    }
    // Idempotent: a second submit after success just returns the verified user.
    if (user.email_verified) {
      return toUserModel(user);
    }

    const active = await emailVerificationRepository.latestActiveForUser(userId);
    if (!active) {
      throw new ValidationError('No active verification code. Request a new one.');
    }
    if (active.expires_at.getTime() < Date.now()) {
      await emailVerificationRepository.markUsed(active.id);
      throw new ValidationError('That code has expired. Request a new one.');
    }
    if (active.attempts >= config.emailVerification.maxAttempts) {
      await emailVerificationRepository.markUsed(active.id);
      throw new RateLimitError('Too many attempts. Request a new code.');
    }
    if (submitted !== active.code) {
      await emailVerificationRepository.incrementAttempts(active.id);
      const remaining = config.emailVerification.maxAttempts - (active.attempts + 1);
      if (remaining <= 0) {
        await emailVerificationRepository.markUsed(active.id);
        throw new RateLimitError('Too many attempts. Request a new code.');
      }
      throw new ValidationError(
        `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} left.`,
      );
    }

    // Correct code: consume it, flip the flag, and record the event. The control plane writes the
    // audit row here — the agent never does.
    await emailVerificationRepository.markUsed(active.id);
    await userRepository.setEmailVerified(userId);
    await auditWriter.write({
      userId,
      action: 'verify',
      resourceType: 'auth',
      resourceId: userId,
      summary: 'You verified your email address.',
      success: true,
      metadata: {},
    });
    const updated = await userRepository.findById(userId);
    if (!updated) {
      throw new NotFoundError('User not found');
    }
    return toUserModel(updated);
  }
}

export const emailVerificationService = new EmailVerificationService();
