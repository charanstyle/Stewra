import type { PublicUser, User, UserRole } from '@stewra/shared-types';
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

/** The minimal non-sensitive projection safe to show in search / contact / participant lists. */
interface PublicUserRow {
  readonly id: string;
  readonly display_name: string;
  readonly email: string;
}
const PUBLIC_COLUMNS = ['id', 'display_name', 'email'] as const;

export function toPublicUser(row: PublicUserRow): PublicUser {
  return { id: row.id, displayName: row.display_name, email: row.email };
}

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

  /**
   * Case-insensitive prefix/substring search by email or display name, for adding contacts. Excludes
   * the caller and caps results. Returns public projections only (never the hash).
   */
  async search(query: string, excludeUserId: string, limit: number): Promise<PublicUser[]> {
    const like = `%${query}%`;
    const rows = await db
      .selectFrom('users')
      .select(PUBLIC_COLUMNS)
      .where('id', '!=', excludeUserId)
      .where((eb) => eb.or([eb('email', 'ilike', like), eb('display_name', 'ilike', like)]))
      .orderBy('display_name', 'asc')
      .limit(limit)
      .execute();
    return rows.map(toPublicUser);
  }

  /** Batch-resolve public profiles for a set of ids (participant/contact list hydration). */
  async findPublicByIds(ids: ReadonlyArray<string>): Promise<PublicUser[]> {
    if (ids.length === 0) return [];
    const rows = await db
      .selectFrom('users')
      .select(PUBLIC_COLUMNS)
      .where('id', 'in', ids)
      .execute();
    return rows.map(toPublicUser);
  }
}

export const userRepository = new UserRepository();
