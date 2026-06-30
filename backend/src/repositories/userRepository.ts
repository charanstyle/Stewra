import type { User, UserRole } from '@stewra/shared-types';
import { db } from '../database/index';

export interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly display_name: string;
  readonly password_hash: string;
  readonly role: UserRole;
  readonly email_verified: boolean;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface NewUserRow {
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly role: UserRole;
}

/** Map a DB row to the public-facing User model (never exposes the password hash). */
export function toUserModel(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    emailVerified: row.email_verified,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const COLUMNS = [
  'id',
  'email',
  'display_name',
  'password_hash',
  'role',
  'email_verified',
  'created_at',
  'updated_at',
] as const;

export class UserRepository {
  async create(input: NewUserRow): Promise<UserRow> {
    return db
      .insertInto('users')
      .values({
        email: input.email,
        display_name: input.displayName,
        password_hash: input.passwordHash,
        role: input.role,
      })
      .returning(COLUMNS)
      .executeTakeFirstOrThrow();
  }

  async findByEmail(email: string): Promise<UserRow | undefined> {
    return db.selectFrom('users').select(COLUMNS).where('email', '=', email).executeTakeFirst();
  }

  async findById(id: string): Promise<UserRow | undefined> {
    return db.selectFrom('users').select(COLUMNS).where('id', '=', id).executeTakeFirst();
  }

  /** Mark the user's email as verified. Idempotent — re-verifying a verified user is a no-op. */
  async setEmailVerified(id: string): Promise<void> {
    await db
      .updateTable('users')
      .set({ email_verified: true, updated_at: new Date() })
      .where('id', '=', id)
      .execute();
  }
}

export const userRepository = new UserRepository();
