import * as Sentry from '@sentry/node';
import type { ProposedEmail } from '@stewra/shared-types';
import { connectionRepository } from '../repositories/connectionRepository';
import { vault } from '../control-plane/vault/vault';
import { auditWriter } from '../control-plane/audit/auditWriter';
import { buildEmailSender, sendableProviders } from './emailSenders';
import { isGoogleAuthError } from './googleOAuthService';
import { logger } from '../utils/logger';

/** Google's send scope — a grant must carry this before Stewra can send AS the user. */
const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

/**
 * Why a confirmed send could not proceed. A short machine code the client maps to a friendly line:
 * `no_send_account` — no connected account has granted send permission (reconnect Gmail with send);
 * `send_failed` — a connected account was found but the provider rejected the send.
 */
export type SendFailureReason = 'no_send_account' | 'send_failed';

/** The outcome the confirm route folds into the proposal's terminal (`sent`/`failed`) state. */
export type SendResult =
  | { readonly ok: true; readonly provider: string }
  | { readonly ok: false; readonly failureReason: SendFailureReason };

/**
 * The TRUSTED, confirm-gated email executor. It is invoked ONLY from the confirm route, after the user
 * explicitly taps "Send" on a proposal the (untrusted) agent drafted — the agent itself has no path
 * here. It resolves a connected account that granted send permission, reads its vaulted credential,
 * dispatches through the provider-agnostic {@link EmailSender} port, and records an append-only audit
 * row either way. Provider selection keys off the user's connections, so this is not Gmail-specific:
 * registering another adapter in `./emailSenders` makes those accounts sendable with no change here.
 */
class EmailActionService {
  async send(userId: string, proposal: ProposedEmail): Promise<SendResult> {
    const providers = new Set(sendableProviders());
    // Only Google/Gmail has an adapter today, so the usable connection is a Google account that granted
    // the send scope. When more adapters land, this widens to "any active connection whose provider is
    // registered and whose grant carries that provider's send scope".
    const usable = providers.has('google')
      ? (await connectionRepository.listActive(userId, 'google')).find((connection) =>
          connection.scopes.includes(GMAIL_SEND_SCOPE),
        )
      : undefined;
    if (usable === undefined) {
      return { ok: false, failureReason: 'no_send_account' };
    }

    const sender = buildEmailSender(usable.provider, await vault.get(usable.vaultRef));
    if (sender === null) {
      return { ok: false, failureReason: 'no_send_account' };
    }

    try {
      const receipt = await sender.send({
        fromEmail: usable.accountEmail,
        to: proposal.to,
        subject: proposal.subject,
        body: proposal.body,
      });
      await auditWriter.write({
        userId,
        action: 'send',
        resourceType: 'email',
        resourceId: receipt.providerMessageId.length > 0 ? receipt.providerMessageId : usable.id,
        summary: `Sent email to ${proposal.to} — "${proposal.subject || '(no subject)'}"`,
        success: true,
        metadata: { provider: receipt.provider, to: proposal.to },
      });
      return { ok: true, provider: receipt.provider };
    } catch (error) {
      // A lost grant (revoked/expired token) is terminal — flip the connection so the UI prompts a
      // reconnect; transient failures just surface as `send_failed` for the user to retry.
      if (isGoogleAuthError(error)) {
        await connectionRepository.setStatus(usable.id, 'revoked');
      }
      Sentry.captureException(error);
      logger.error('confirm-gated email send failed', { userId, err: String(error) });
      await auditWriter.write({
        userId,
        action: 'send',
        resourceType: 'email',
        resourceId: usable.id,
        summary: `Failed to send email to ${proposal.to}`,
        success: false,
        metadata: { provider: usable.provider, to: proposal.to },
      });
      return { ok: false, failureReason: 'send_failed' };
    }
  }
}

export const emailActionService = new EmailActionService();
