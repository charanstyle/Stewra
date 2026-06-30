import type { ISODateString, UUID } from '../common/base';

export type UserRole = 'user' | 'admin';

/** Public-facing user shape (never includes the password hash). */
export interface User {
  readonly id: UUID;
  readonly email: string;
  readonly displayName: string;
  readonly role: UserRole;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
}
