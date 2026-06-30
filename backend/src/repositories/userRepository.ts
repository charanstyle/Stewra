import type { UserRole } from '@stewra/shared-types';
import { db } from '../database/index';

export interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly display_name: string;
  readonly password_hash: string;
  readonly role: UserRole;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface NewUserRow {
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly role: UserRole;
}

const COLUMNS = [
  'id',
  'email',
  'display_name',
  'password_hash',
  'role',
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
}

export const userRepository = new UserRepository();
