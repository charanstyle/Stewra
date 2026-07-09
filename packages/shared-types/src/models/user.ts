import type { ISODateString, UUID } from '../common/base';

export type UserRole = 'user' | 'admin';

/** Public-facing user shape (never includes the password hash). */
export interface User {
  readonly id: UUID;
  readonly email: string;
  readonly displayName: string;
  readonly role: UserRole;
  /**
   * Whether the user has proven ownership of their email (entered the code we sent). Side-effectful
   * surfaces (connecting a source, generating an insight) are gated on this being true.
   */
  readonly emailVerified: boolean;
  /**
   * Relative URL of the user's own profile photo (`/media/{assetId}`), or null when unset. Lets the
   * settings surface render the current avatar on load; mirrors {@link PublicUser.avatarUrl}.
   */
  readonly avatarUrl: string | null;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
}
