import { sql } from 'kysely';
import { db } from '../database/index.js';

/** A single issued password-reset code, as stored. */
export interface PasswordResetCodeRow {
  readonly id: string;
  readonly user_id: string;
  readonly code: string;
  readonly email: string;
  readonly expires_at: Date;
  readonly used: boolean;
  readonly attempts: number;
  readonly created_at: Date;
}

export interface NewPasswordResetCode {
  readonly userId: string;
  readonly code: string;
  readonly email: string;
  readonly expiresAt: Date;
}

const COLUMNS = ['id', 'user_id', 'code', 'email', 'expires_at', 'used', 'attempts', 'created_at'] as const;

export class PasswordResetRepository {
  async create(input: NewPasswordResetCode): Promise<void> {
    await db
      .insertInto('password_reset_codes')
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
      .updateTable('password_reset_codes')
      .set({ used: true })
      .where('user_id', '=', userId)
      .where('used', '=', false)
      .execute();
  }

  /** The most recently issued code for the user, regardless of state — used for the resend cooldown. */
  async latestForUser(userId: string): Promise<PasswordResetCodeRow | undefined> {
    return db
      .selectFrom('password_reset_codes')
      .select(COLUMNS)
      .where('user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
  }

  /** The most recent un-consumed code for the user — the one a confirm attempt is checked against. */
  async latestActiveForUser(userId: string): Promise<PasswordResetCodeRow | undefined> {
    return db
      .selectFrom('password_reset_codes')
      .select(COLUMNS)
      .where('user_id', '=', userId)
      .where('used', '=', false)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
  }

  async incrementAttempts(id: string): Promise<void> {
    await db
      .updateTable('password_reset_codes')
      .set({ attempts: sql<number>`attempts + 1` })
      .where('id', '=', id)
      .execute();
  }

  async markUsed(id: string): Promise<void> {
    await db
      .updateTable('password_reset_codes')
      .set({ used: true })
      .where('id', '=', id)
      .execute();
  }
}

export const passwordResetRepository = new PasswordResetRepository();
