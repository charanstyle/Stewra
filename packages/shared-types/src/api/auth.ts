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
