import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import type {
  AuthTokens,
  LoginRequest,
  LoginResponse,
  RefreshTokenResponse,
  RegisterRequest,
  RegisterResponse,
  User,
} from '@stewra/shared-types';
import { config } from '../config/unifiedConfig';
import { logger } from '../utils/logger';
import { AuthenticationError, ConflictError, NotFoundError } from '../utils/errors';
import type { UserRepository } from '../repositories/userRepository';
import { userRepository, toUserModel } from '../repositories/userRepository';
import type { AuditWriter } from '../control-plane/audit/auditWriter';
import { auditWriter } from '../control-plane/audit/auditWriter';
import { emailVerificationService } from './emailVerificationService';

const TokenClaimsSchema = z.object({
  sub: z.string().min(1),
  type: z.enum(['access', 'refresh']),
});

/** Parse a duration string like "2h"/"7d" to seconds. Fails loudly on a bad format. */
function durationToSeconds(value: string): number {
  const match = /^(\d+)([smhdw])$/.exec(value);
  if (!match) {
    throw new Error(`Invalid duration: ${value}`);
  }
  const amount = Number(match[1]);
  const unit = match[2];
  const unitSeconds: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  const factor = unit === undefined ? undefined : unitSeconds[unit];
  if (factor === undefined) {
    throw new Error(`Invalid duration unit: ${unit ?? value}`);
  }
  return amount * factor;
}

export class AuthService {
  private readonly users: UserRepository;
  private readonly audit: AuditWriter;

  constructor(users: UserRepository, audit: AuditWriter) {
    this.users = users;
    this.audit = audit;
  }

  private issueTokens(userId: string): AuthTokens {
    const accessToken = jwt.sign({ sub: userId, type: 'access' }, config.auth.jwtSecret, {
      expiresIn: durationToSeconds(config.auth.accessTtl),
    });
    const refreshToken = jwt.sign({ sub: userId, type: 'refresh' }, config.auth.jwtSecret, {
      expiresIn: durationToSeconds(config.auth.refreshTtl),
    });
    return { accessToken, refreshToken };
  }

  /** Verify a token and return its subject. Throws AuthenticationError on any problem. */
  verifyToken(token: string, expectedType: 'access' | 'refresh'): string {
    let decoded: string | jwt.JwtPayload;
    try {
      decoded = jwt.verify(token, config.auth.jwtSecret);
    } catch {
      throw new AuthenticationError('Invalid or expired token');
    }
    const claims = TokenClaimsSchema.safeParse(decoded);
    if (!claims.success || claims.data.type !== expectedType) {
      throw new AuthenticationError('Invalid token');
    }
    return claims.data.sub;
  }

  async register(req: RegisterRequest): Promise<RegisterResponse> {
    const existing = await this.users.findByEmail(req.email);
    if (existing) {
      throw new ConflictError('An account with that email already exists');
    }
    const passwordHash = await bcrypt.hash(req.password, config.auth.bcryptRounds);
    const row = await this.users.create({
      email: req.email,
      displayName: req.displayName,
      passwordHash,
      role: 'user',
    });
    const user = toUserModel(row);
    await this.audit.write({
      userId: user.id,
      action: 'auth.register',
      resourceType: 'auth',
      resourceId: user.id,
      summary: 'You created your Stewra account.',
      success: true,
      metadata: {},
    });
    // Email the first verification code. A transient send failure must NOT fail registration — the
    // account exists and is audited; the user lands on the verify screen and can resend.
    try {
      await emailVerificationService.issue(user.id, user.email);
    } catch (error) {
      logger.error('Failed to send verification email at registration', {
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return {
      user,
      tokens: this.issueTokens(user.id),
      requiresVerification: !user.emailVerified,
    };
  }

  async login(req: LoginRequest): Promise<LoginResponse> {
    const row = await this.users.findByEmail(req.email);
    // Always compare against a hash to avoid leaking which emails exist via timing.
    const hash = row?.password_hash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
    const ok = await bcrypt.compare(req.password, hash);
    if (!row || !ok) {
      throw new AuthenticationError('Invalid email or password');
    }
    const user = toUserModel(row);
    await this.audit.write({
      userId: user.id,
      action: 'auth.login',
      resourceType: 'auth',
      resourceId: user.id,
      summary: 'You signed in to Stewra.',
      success: true,
      metadata: {},
    });
    return { user, tokens: this.issueTokens(user.id) };
  }

  async refresh(refreshToken: string): Promise<RefreshTokenResponse> {
    const userId = this.verifyToken(refreshToken, 'refresh');
    const row = await this.users.findById(userId);
    if (!row) {
      throw new AuthenticationError('Invalid token');
    }
    await this.audit.write({
      userId,
      action: 'auth.refresh',
      resourceType: 'auth',
      resourceId: userId,
      summary: 'Your session was refreshed.',
      success: true,
      metadata: {},
    });
    return { tokens: this.issueTokens(userId) };
  }

  async getStatus(userId: string): Promise<User> {
    const row = await this.users.findById(userId);
    if (!row) {
      throw new NotFoundError('User not found');
    }
    return toUserModel(row);
  }
}

export const authService = new AuthService(userRepository, auditWriter);
