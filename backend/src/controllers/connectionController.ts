import type { Request, Response } from 'express';
import { z } from 'zod';
import * as Sentry from '@sentry/node';
import type {
  StartCalendarConnectionResponse,
  StartMoneyConnectionResponse,
  ListConnectionsResponse,
  ConnectionResponse,
} from '@stewra/shared-types';
import { BaseController } from './baseController.js';
import { config } from '../config/unifiedConfig.js';
import { connectionRepository } from '../repositories/connectionRepository.js';
import { vault } from '../control-plane/vault/vault.js';
import { auditWriter } from '../control-plane/audit/auditWriter.js';
import {
  buildGoogleConsent,
  verifyCalendarState,
  exchangeCodeForRefreshToken,
  fetchAccountEmail,
  revokeRefreshToken,
} from '../services/googleOAuthService.js';
import {
  createLinkToken,
  exchangePublicToken,
  removeItem,
} from '../services/plaidService.js';
import { transactionSyncService } from '../services/transactionSyncService.js';
import { purgeConnectionMoneyData } from '../repositories/moneyStore.js';
import { memoryService } from '../services/memoryService.js';
import { processMemoryService } from '../services/processMemoryService.js';
import { emailRetentionService } from '../services/emailRetentionService.js';
import { parse } from '../utils/validate.js';
import { NotFoundError, ServiceUnavailableError } from '../utils/errors.js';

// The OAuth callback Google redirects the browser to — carries the code and our signed state.
const callbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

const disconnectParamsSchema = z.object({
  id: z.string().uuid(),
});

// Plaid Link hands the client a one-time public token; the client posts it here for exchange.
const exchangePlaidSchema = z.object({
  publicToken: z.string().min(1),
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

  /**
   * POST /connections/plaid/start — the plain-language consent + a short-lived Link token. Refuses
   * with a 503 naming the flag when no aggregator is configured: nothing about the request is
   * wrong, and it will work unchanged once the operator turns the integration on.
   */
  async startPlaid(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.userId;
      if (userId === undefined) {
        throw new Error('startPlaid() requires requireAuth middleware');
      }
      const money = config.moneyAggregator;
      if (!money.enabled) {
        throw new ServiceUnavailableError(
          'Bank connections are not enabled on this install (MONEY_AGGREGATOR_ENABLED=false)',
        );
      }
      const linkToken = await createLinkToken(userId);
      const body: StartMoneyConnectionResponse = { consentPrompt: money.consentPrompt, linkToken };
      this.handleSuccess(res, body, 200);
    } catch (error) {
      this.handleError(error, res, 'ConnectionController.startPlaid');
    }
  }

  /**
   * POST /connections/plaid/exchange — swap Link's one-time public token for the long-lived access
   * token, which goes STRAIGHT into the vault (never logged, never returned), and record the
   * connection keyed by Plaid's item id (banks have no email; the item id is the stable per-grant
   * identity the unique index needs). An authenticated JSON call, not a browser redirect — Link
   * runs client-side, so no signed state is involved.
   */
  async exchangePlaid(req: Request, res: Response): Promise<void> {
    try {
      const userId = req.userId;
      if (userId === undefined) {
        throw new Error('exchangePlaid() requires requireAuth middleware');
      }
      const money = config.moneyAggregator;
      if (!money.enabled) {
        throw new ServiceUnavailableError(
          'Bank connections are not enabled on this install (MONEY_AGGREGATOR_ENABLED=false)',
        );
      }
      const { publicToken } = parse(exchangePlaidSchema, req.body);
      const { accessToken, itemId } = await exchangePublicToken(publicToken);

      // Reconnecting the same Item replaces its token — purge the superseded ciphertext, exactly
      // like the Google callback does.
      const priorVaultRef = await connectionRepository.vaultRefForAccount(
        userId,
        'aggregator',
        itemId,
      );
      const vaultRef = await vault.put(accessToken);
      const row = await connectionRepository.upsert(
        userId,
        'aggregator',
        itemId,
        vaultRef,
        money.products,
      );
      if (priorVaultRef !== undefined && priorVaultRef !== vaultRef) {
        await vault.delete(priorVaultRef);
      }

      await auditWriter.write({
        userId,
        action: 'connect',
        resourceType: 'system',
        resourceId: null,
        summary: 'Connected a bank (balances + transactions, read-only)',
        success: true,
        metadata: { itemId, provider: 'aggregator' },
      });

      // Pull the first snapshot now so facts exist the moment the user looks. Best-effort: a slow
      // or briefly failing first sync must not fail the connect the user just completed — the
      // scheduled sync (or /home/recompute) will catch up.
      try {
        await transactionSyncService.syncConnection(row);
      } catch (error) {
        Sentry.captureException(error);
      }

      const connection = await connectionRepository.listForUser(userId);
      const created = connection.find((c) => c.id === row.id);
      if (created === undefined) {
        throw new Error('exchangePlaid: connection vanished after upsert');
      }
      const body: ConnectionResponse = { connection: created };
      this.handleSuccess(res, body, 200);
    } catch (error) {
      this.handleError(error, res, 'ConnectionController.exchangePlaid');
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
      // credential at its provider (Google's token endpoint, or Plaid's /item/remove), then delete
      // the ciphertext from the vault so no dead credential lingers at rest. Both are best-effort —
      // a credential the provider already dropped, or an already-purged secret, must not block the
      // user's revoke — but we record whether the provider acknowledged it.
      let revokedAtProvider = false;
      try {
        const secret = await vault.get(existing.vaultRef);
        revokedAtProvider =
          existing.provider === 'aggregator'
            ? await removeItem(secret)
            : await revokeRefreshToken(secret);
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
        summary:
          existing.provider === 'aggregator'
            ? 'Disconnected a bank connection'
            : `Disconnected Google account ${existing.accountEmail}`,
        success: true,
        metadata: { accountEmail: existing.accountEmail, revokedAtProvider },
      });

      // Forget-on-disconnect: purge learnings derived from a source the user just revoked, so nothing
      // built from it lingers. Scoped to kinds this provider no longer authorizes (a second Google
      // account keeps its calendar/gmail learnings). Its own 'forget' audit rows are written inside.
      // Both the task-scoped exemplars and the generalized process/style rules are reconciled; the
      // latter also purges any vaulted contact behind an `identifying` rule.
      await memoryService.forgetForDisconnectedProvider(userId, existing.provider);
      await processMemoryService.forgetForDisconnectedProvider(userId, existing.provider);
      // Also purge this connection's per-source store (its rows are only flipped to revoked, so the
      // ON DELETE CASCADE never fires): the encrypted email store + vaulted contact addresses for
      // Google, the money store (accounts, transactions, sync cursor) for a bank.
      if (existing.provider === 'aggregator') {
        await purgeConnectionMoneyData(id);
      } else {
        await emailRetentionService.forgetForDisconnectedConnection(userId, id);
      }

      const body: ConnectionResponse = { connection };
      this.handleSuccess(res, body, 200);
    } catch (error) {
      this.handleError(error, res, 'ConnectionController.disconnect');
    }
  }
}

export const connectionController = new ConnectionController();
