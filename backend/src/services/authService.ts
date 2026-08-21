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
import * as Sentry from '@sentry/node';
import { config } from '../config/unifiedConfig.js';
import { logger } from '../utils/logger.js';
import { AuthenticationError, ConflictError, NotFoundError } from '../utils/errors.js';
import type { UserRepository } from '../repositories/userRepository.js';
import { userRepository, toUserModel } from '../repositories/userRepository.js';
import type { AuditWriter } from '../control-plane/audit/auditWriter.js';
import { auditWriter } from '../control-plane/audit/auditWriter.js';
import { emailVerificationService } from './emailVerificationService.js';
import { db } from '../database/index.js';
import {
  organizationRepository,
  slugify,
} from '../tenancy/repositories/organizationRepository.js';

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

    // Every account is a tenant: the user and their organization are created in ONE transaction, so
    // a person with no org is not a state the database can hold, even transiently. An individual
    // org takes the person's name; a business takes the company's. The controller already refused
    // a business with no company name, but this is the line that must not trust that, hence the
    // throw rather than a substitute.
    const orgName = req.accountKind === 'business' ? req.companyName : req.displayName;
    if (orgName === undefined || orgName.trim().length === 0) {
      throw new Error('register: a business account reached the service with no company name');
    }
    const { row, org } = await db.transaction().execute(async (trx) => {
      const userRow = await this.users.create(
        { email: req.email, displayName: req.displayName, passwordHash, role: 'user' },
        trx,
      );
      const created = await organizationRepository.create(
        {
          name: orgName.trim(),
          slug: slugify(orgName),
          kind: req.accountKind,
          createdBy: userRow.id,
        },
        trx,
      );
      return { row: userRow, org: created.org };
    });
    const user = toUserModel(row);
    await this.audit.write({
      userId: user.id,
      action: 'auth.register',
      resourceType: 'auth',
      resourceId: user.id,
      summary:
        req.accountKind === 'business'
          ? `You created your Stewra account and the organization ${org.name}.`
          : 'You created your Stewra account.',
      success: true,
      metadata: { accountKind: req.accountKind, orgId: org.id },
    });
    // Email the first verification code. A transient send failure must NOT fail registration — the
    // account exists and is audited; the user lands on the verify screen and can resend.
    try {
      await emailVerificationService.issue(user.id, user.email);
    } catch (error) {
      // Not failing registration is right — the account exists and is audited. But the user is now
      // sitting on a verify screen waiting for a mail that will never arrive, and until this capture
      // existed the only trace was a log line on a box nobody tails.
      Sentry.captureException(error, {
        tags: { surface: 'registration', step: 'verification_email' },
        extra: { userId: user.id },
      });
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

  /**
   * Re-verify a signed-in user's password. Used to gate a security-relevant action (e.g. enabling
   * approve-to-send email over WhatsApp) so that holding a session alone is not enough — the user must
   * still know the password. Throws `AuthenticationError` on any mismatch; returns nothing on success.
   *
   * A pure primitive: it does NOT audit or mutate. The caller records the action it was gating. Missing
   * user and empty/absent password both compare against a dummy hash, so this leaks neither existence nor
   * "you didn't send a password" through timing.
   */
  async reverifyPassword(userId: string, password: string | undefined): Promise<void> {
    const row = await this.users.findById(userId);
    const hash = row?.password_hash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
    const ok = await bcrypt.compare(password ?? '', hash);
    if (!row || !ok) {
      throw new AuthenticationError('Password is incorrect');
    }
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
