import { sql } from 'kysely';
import { db } from '../database/index';

/** A single issued verification code, as stored. */
export interface EmailVerificationCodeRow {
  readonly id: string;
  readonly user_id: string;
  readonly code: string;
  readonly email: string;
  readonly expires_at: Date;
  readonly used: boolean;
  readonly attempts: number;
  readonly created_at: Date;
}

export interface NewEmailVerificationCode {
  readonly userId: string;
  readonly code: string;
  readonly email: string;
  readonly expiresAt: Date;
}

const COLUMNS = ['id', 'user_id', 'code', 'email', 'expires_at', 'used', 'attempts', 'created_at'] as const;

export class EmailVerificationRepository {
  async create(input: NewEmailVerificationCode): Promise<void> {
    await db
      .insertInto('email_verification_codes')
      .values({
        user_id: input.userId,
        code: input.code,
        email: input.email,
        expires_at: input.expiresAt,
      })
      .execute();
  }

  /** Burn every still-active code for the user (called before issuing a fresh one). */
  async markActiveUsed(userId: string): Promise<void> {
    await db
      .updateTable('email_verification_codes')
      .set({ used: true })
      .where('user_id', '=', userId)
      .where('used', '=', false)
      .execute();
  }

  /** The most recently issued code for the user, regardless of state — used for the resend cooldown. */
  async latestForUser(userId: string): Promise<EmailVerificationCodeRow | undefined> {
    return db
      .selectFrom('email_verification_codes')
      .select(COLUMNS)
      .where('user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
  }

  /** The most recent un-consumed code for the user — the one a verify attempt is checked against. */
  async latestActiveForUser(userId: string): Promise<EmailVerificationCodeRow | undefined> {
    return db
      .selectFrom('email_verification_codes')
      .select(COLUMNS)
      .where('user_id', '=', userId)
      .where('used', '=', false)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
  }

  async incrementAttempts(id: string): Promise<void> {
    await db
      .updateTable('email_verification_codes')
      .set({ attempts: sql<number>`attempts + 1` })
      .where('id', '=', id)
      .execute();
  }

  async markUsed(id: string): Promise<void> {
    await db
      .updateTable('email_verification_codes')
      .set({ used: true })
      .where('id', '=', id)
      .execute();
  }
}

export const emailVerificationRepository = new EmailVerificationRepository();
