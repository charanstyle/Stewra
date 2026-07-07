import type { Request, Response } from 'express';
import { z } from 'zod';
import * as Sentry from '@sentry/node';
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
  revokeRefreshToken,
} from '../services/googleOAuthService';
import { memoryService } from '../services/memoryService';
import { processMemoryService } from '../services/processMemoryService';
import { emailRetentionService } from '../services/emailRetentionService';
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

      const { refreshToken, scopes } = await exchangeCodeForRefreshToken(code);
      const accountEmail = await fetchAccountEmail(refreshToken);

      // Reconnecting the same account replaces its token — capture the handle it's about to
      // supersede so we can purge the old ciphertext from the vault after the upsert succeeds.
      const priorVaultRef = await connectionRepository.vaultRefForAccount(
        userId,
        'google',
        accountEmail,
      );
      const vaultRef = await vault.put(refreshToken);
      await connectionRepository.upsert(userId, 'google', accountEmail, vaultRef, scopes);
      if (priorVaultRef !== undefined && priorVaultRef !== vaultRef) {
        await vault.delete(priorVaultRef);
      }

      // Reflect in the audit summary whether this grant covers acting on the user's behalf (send/
      // modify) or is read-only — so the record is honest about the access the user just granted.
      const canAct = config.google.requiredScopes.every((s) => scopes.includes(s));
      await auditWriter.write({
        userId,
        action: 'connect',
        resourceType: 'system',
        resourceId: null,
        summary: canAct
          ? `Connected Google account ${accountEmail} (Calendar + Gmail; can send/modify on confirm)`
          : `Connected Google account ${accountEmail} (Calendar + Gmail, read-only)`,
        success: true,
        metadata: { accountEmail, canAct },
      });

      res.redirect(302, `${config.web.appUrl}/activity?connected=google`);
    } catch (error) {
      // A failed callback can't render JSON into a browser tab usefully — capture it for triage and
      // send the browser back to the app with an error flag the UI can surface plainly.
      Sentry.captureException(error);
      res.redirect(302, `${config.web.appUrl}/activity?connected=error`);
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

      // A one-tap disconnect must sever access everywhere, not just flip a local flag. Revoke the
      // token at Google, then delete the ciphertext from the vault so no dead credential lingers at
      // rest. Both are best-effort — a token Google already dropped, or an already-purged secret,
      // must not block the user's revoke — but we record whether Google acknowledged it.
      let revokedAtGoogle = false;
      try {
        const refreshToken = await vault.get(existing.vaultRef);
        revokedAtGoogle = await revokeRefreshToken(refreshToken);
        await vault.delete(existing.vaultRef);
      } catch (error) {
        Sentry.captureException(error);
      }

      const connection = await connectionRepository.setStatus(id, 'revoked');

      await auditWriter.write({
        userId,
        action: 'disconnect',
        resourceType: 'system',
        resourceId: id,
        summary: `Disconnected Google account ${existing.accountEmail}`,
        success: true,
        metadata: { accountEmail: existing.accountEmail, revokedAtGoogle },
      });

      // Forget-on-disconnect: purge learnings derived from a source the user just revoked, so nothing
      // built from it lingers. Scoped to kinds this provider no longer authorizes (a second Google
      // account keeps its calendar/gmail learnings). Its own 'forget' audit rows are written inside.
      // Both the task-scoped exemplars and the generalized process/style rules are reconciled; the
      // latter also purges any vaulted contact behind an `identifying` rule.
      await memoryService.forgetForDisconnectedProvider(userId, existing.provider);
      await processMemoryService.forgetForDisconnectedProvider(userId, existing.provider);
      // Also purge the encrypted email store for this specific connection (its rows are only
      // flipped to revoked, so the ON DELETE CASCADE never fires) and the vaulted contact addresses.
      await emailRetentionService.forgetForDisconnectedConnection(userId, id);

      const body: ConnectionResponse = { connection };
      this.handleSuccess(res, body, 200);
    } catch (error) {
      this.handleError(error, res, 'ConnectionController.disconnect');
    }
  }
}

export const connectionController = new ConnectionController();
