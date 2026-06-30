import type { Request, Response } from 'express';
import { z } from 'zod';
import type {
  StartCalendarConnectionResponse,
  ListConnectionsResponse,
  ConnectionResponse,
} from '@stewra/shared-types';
import { BaseController } from './baseController';
import { config } from '../config/unifiedConfig';
import { connectionRepository } from '../repositories/connectionRepository';
import { vault } from '../control-plane/vault/vault';
import { auditWriter } from '../control-plane/audit/auditWriter';
import {
  buildGoogleConsent,
  verifyCalendarState,
  exchangeCodeForRefreshToken,
  fetchAccountEmail,
} from '../services/googleOAuthService';
import { parse } from '../utils/validate';
import { NotFoundError } from '../utils/errors';

// The OAuth callback Google redirects the browser to — carries the code and our signed state.
const callbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

const disconnectParamsSchema = z.object({
  id: z.string().uuid(),
});

class ConnectionController extends BaseController {
  /** POST /connections/google/start — return the plain-language consent + the authorize URL. */
  async startGoogle(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.userId;
      if (userId === undefined) {
        throw new Error('startGoogle() requires requireAuth middleware');
      }
      const { consentPrompt, authorizeUrl } = buildGoogleConsent(userId);
      const body: StartCalendarConnectionResponse = { consentPrompt, authorizeUrl };
      this.handleSuccess(res, body, 200);
    } catch (error) {
      this.handleError(error, res, 'ConnectionController.startGoogle');
    }
  }

  /**
   * GET /connections/google/callback — NOT behind requireAuth (it's a browser redirect with no
   * Authorization header). The signed `state` carries the user id. We exchange the code for a
   * refresh token, store ONLY the token in the vault (never logged, never returned), record the
   * connection, audit it, and redirect the browser back to the website.
   */
  async googleCallback(req: Request, res: Response): Promise<void> {
    try {
      const { code, state } = parse(callbackSchema, req.query);
      const userId = verifyCalendarState(state);

      const refreshToken = await exchangeCodeForRefreshToken(code);
      const accountEmail = await fetchAccountEmail(refreshToken);
      const vaultRef = await vault.put(refreshToken);
      await connectionRepository.upsert(userId, 'google', accountEmail, vaultRef);

      await auditWriter.write({
        userId,
        action: 'connect',
        resourceType: 'system',
        resourceId: null,
        summary: `Connected Google account ${accountEmail} (Calendar + Gmail, read-only)`,
        success: true,
        metadata: { accountEmail },
      });

      res.redirect(302, `${config.web.appUrl}/activity?connected=google`);
    } catch (error) {
      // A failed callback can't render JSON into a browser tab usefully — send them back with a flag.
      this.handleError(error, res, 'ConnectionController.googleCallback');
    }
  }

  /** GET /connections — all of the user's connections (active and revoked), no vault handles. */
  async list(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.userId;
      if (userId === undefined) {
        throw new Error('list() requires requireAuth middleware');
      }
      const connections = await connectionRepository.listForUser(userId);
      const body: ListConnectionsResponse = { connections };
      this.handleSuccess(res, body, 200);
    } catch (error) {
      this.handleError(error, res, 'ConnectionController.list');
    }
  }

  /** POST /connections/:id/disconnect — one-tap revoke; the connection flips to `revoked`. */
  async disconnect(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.userId;
      if (userId === undefined) {
        throw new Error('disconnect() requires requireAuth middleware');
      }
      const { id } = parse(disconnectParamsSchema, req.params);
      const existing = await connectionRepository.findByIdForUser(id, userId);
      if (existing === undefined) {
        throw new NotFoundError('Connection not found');
      }

      const connection = await connectionRepository.setStatus(id, 'revoked');

      await auditWriter.write({
        userId,
        action: 'disconnect',
        resourceType: 'system',
        resourceId: id,
        summary: `Disconnected Google account ${existing.accountEmail}`,
        success: true,
        metadata: { accountEmail: existing.accountEmail },
      });

      const body: ConnectionResponse = { connection };
      this.handleSuccess(res, body, 200);
    } catch (error) {
      this.handleError(error, res, 'ConnectionController.disconnect');
    }
  }
}

export const connectionController = new ConnectionController();
