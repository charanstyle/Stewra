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
