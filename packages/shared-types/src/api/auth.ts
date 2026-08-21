// @skip-validation — this file IS the shared-types package; see api/organizations.ts for why the
// api-contract guard cannot be satisfied from inside it.
import type { OrgKind } from '../models/organization';
import type { User } from '../models/user';

/** Access + refresh token pair returned on register/login/refresh. */
export interface AuthTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
}

export interface RegisterRequest {
  readonly email: string;
  readonly password: string;
  readonly displayName: string;
  /**
   * Which shape of account this is. Every account gets an organization inside the same transaction
   * that creates the user — `individual` names it after the person, `business` names it
   * `companyName`. Required: the person states it, the server never infers it.
   */
  readonly accountKind: OrgKind;
  /** Required when `accountKind` is `business`, and rejected when it is `individual`. */
  readonly companyName?: string;
}

export interface RegisterResponse {
  readonly user: User;
  readonly tokens: AuthTokens;
  /**
   * True when a verification code was emailed and the user must verify before using gated features.
   * (Derivable from `user.emailVerified`, surfaced explicitly so the client can route to /verify-email.)
   */
  readonly requiresVerification: boolean;
}

export interface LoginRequest {
  readonly email: string;
  readonly password: string;
}

export interface LoginResponse {
  readonly user: User;
  readonly tokens: AuthTokens;
}

export interface RefreshTokenRequest {
  readonly refreshToken: string;
}

export interface RefreshTokenResponse {
  readonly tokens: AuthTokens;
}

export interface GetAuthStatusResponse {
  readonly user: User;
}
