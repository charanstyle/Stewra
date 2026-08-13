import type { CommercePlatform, ContactConsent } from '@stewra/shared-types';
import type {
  NormalizedDeliveryReceipt,
  NormalizedInboundMessage,
  NormalizedTemplateEvent,
} from './inbound/types.js';
import { consentService } from './consentService.js';
import { costRatingService } from './costRatingService.js';
import { templateService } from './templateService.js';
import { channelAccountRepository } from '../repositories/channelAccountRepository.js';
import { commerceInboxRepository } from '../repositories/commerceInboxRepository.js';
import { logger } from '../../utils/logger.js';

/**
 * A placeholder body for a message we cannot render. Not a substituted value: the message genuinely
 * arrived, and an agent must see that a customer sent something rather than see nothing at all.
 */
function placeholderFor(messageType: string): string {
  return `[${messageType} message — open WhatsApp to view]`;
}

/**
 * Where an inbound commerce message becomes a row in exactly one organization's inbox.
 *
 * The single hard rule: an account nobody has connected is DROPPED, loudly, never guessed at. Meta
 * delivers every tenant's traffic to one URL, so if the WABA id in a payload does not resolve to a
 * `channel_accounts` row, there is no organization this belongs to — and picking one would put a
 * stranger's customers into a business's inbox. A warning with the id is the correct outcome; a
 * default tenant would be a data breach.
 */
class CommerceInboundService {
  async handle(message: NormalizedInboundMessage): Promise<void> {
    const account = await channelAccountRepository.findByExternalAccount(
      message.platform,
      message.externalAccountId,
    );
    if (account === null) {
      logger.warn('commerce webhook: no organization owns this account — dropping', {
        platform: message.platform,
        externalAccountId: message.externalAccountId,
      });
      return;
    }

    // Claim before any write. Meta retries until it sees a 200 and can redeliver for seven days, so
    // the second arrival of a message must not append a duplicate to the thread.
    const claimed = await commerceInboxRepository.claimInbound(
      message.platform,
      message.providerMessageId,
    );
    if (!claimed) {
      logger.debug('commerce webhook: duplicate delivery ignored', {
        providerMessageId: message.providerMessageId,
      });
      return;
    }

    const contactId = await commerceInboxRepository.upsertContact({
      orgId: account.orgId,
      platform: message.platform,
      externalId: message.externalContactId,
      displayName: message.contactDisplayName,
      phoneE164: toE164(message.platform, message.externalContactId),
    });

    const conversationId = await commerceInboxRepository.upsertConversation({
      orgId: account.orgId,
      channelAccountId: account.id,
      contactId,
      platform: message.platform,
    });

    const body = message.text ?? placeholderFor(message.messageType);
    await commerceInboxRepository.recordInbound({
      orgId: account.orgId,
      conversationId,
      platform: message.platform,
      providerMessageId: message.providerMessageId,
      body,
      sentAt: message.sentAt,
    });

    // "STOP" has to take effect from the customer's side, not only from an operator's screen. This
    // runs AFTER the message is recorded so the thread shows what they actually wrote — an opt-out
    // that vanishes from the transcript is an opt-out nobody can verify happened.
    //
    // It is also deliberately not allowed to fail the delivery: the message is already stored and
    // Meta has been acked, so throwing here would only lose the log line. The failure is reported
    // rather than swallowed into a success — an opt-out that did not record is a real problem, and
    // the next send attempt must not be told everything is fine.
    let keywordConsent: ContactConsent | null = null;
    if (message.text !== null) {
      try {
        keywordConsent = await consentService.applyInboundKeyword({
          orgId: account.orgId,
          contactId,
          platform: message.platform,
          externalId: message.externalContactId,
          body,
          providerMessageId: message.providerMessageId,
        });
      } catch (error) {
        logger.error('commerce webhook: failed to apply inbound consent keyword', {
          orgId: account.orgId,
          contactId,
          providerMessageId: message.providerMessageId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Where they came from: an opt-in link's token in the text, or Meta's referral block on a message
    // that began at an ad. Deliberately AFTER the keyword pass and told its result, so that a message
    // which was both an opt-out and an entry point resolves as the opt-out.
    //
    // Non-fatal for the same reason the keyword pass is — the message is stored and Meta is acked, so
    // throwing here would only lose the log line — and reported for the same reason too: an opt-in
    // that failed to record means the next campaign will refuse to reach someone who agreed to it.
    try {
      await consentService.applyEntryPoint({
        orgId: account.orgId,
        contactId,
        platform: message.platform,
        externalId: message.externalContactId,
        body,
        providerMessageId: message.providerMessageId,
        referral: message.referral,
        optedOutJustNow: keywordConsent?.state === 'opted_out',
      });
    } catch (error) {
      logger.error('commerce webhook: failed to record an entry-point consent', {
        orgId: account.orgId,
        contactId,
        providerMessageId: message.providerMessageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * One delivery receipt — the only place a message's cost ever comes from.
   *
   * Same tenant rule as inbound: the WABA id resolves the org, and a receipt for an account nobody
   * connected is dropped with a warning. A receipt matching no message is also ordinary — another
   * tool sending on the same number produces receipts for sends this build never made.
   */
  async handleReceipt(receipt: NormalizedDeliveryReceipt): Promise<void> {
    const account = await channelAccountRepository.findByExternalAccount(
      receipt.platform,
      receipt.externalAccountId,
    );
    if (account === null) {
      logger.warn('commerce webhook: receipt for an account nobody owns — dropping', {
        platform: receipt.platform,
        externalAccountId: receipt.externalAccountId,
      });
      return;
    }

    const matched = await commerceInboxRepository.applyDeliveryStatus({
      orgId: account.orgId,
      providerMessageId: receipt.providerMessageId,
      status: receipt.status,
      failureReason: receipt.failureReason,
      pricingCategory: receipt.pricingCategory,
      providerCategory: receipt.providerCategory,
      pricingModel: receipt.pricingModel,
      billable: receipt.billable,
      providerConversationId: receipt.providerConversationId,
    });
    if (matched === null) {
      logger.debug('commerce webhook: receipt matched no message of ours', {
        orgId: account.orgId,
        providerMessageId: receipt.providerMessageId,
        status: receipt.status,
      });
      return;
    }

    // Rate the moment `billable` is known — from the MERGED row, not this receipt's fragment, so
    // a status-only retry after a priced receipt still rates the message it re-announces. Errors
    // propagate: the webhook fan-out logs and captures them, the message simply stays unpriced
    // (visible as `unpricedMessages` / `complete: false`), and 2.4's backfill job re-rates.
    if (matched.billable !== null) {
      await costRatingService.rateMessage({
        orgId: account.orgId,
        messageId: matched.messageId,
        conversationId: matched.conversationId,
        billable: matched.billable,
        pricingCategory: matched.pricingCategory,
        providerConversationId: matched.providerConversationId,
        billingCurrency: account.billingCurrency,
      });
    }
  }

  /** One template status/category change, applied to the mirror the moment Meta pushes it. */
  async handleTemplateEvent(event: NormalizedTemplateEvent): Promise<void> {
    const account = await channelAccountRepository.findByExternalAccount(
      event.platform,
      event.externalAccountId,
    );
    if (account === null) {
      logger.warn('commerce webhook: template event for an account nobody owns — dropping', {
        platform: event.platform,
        externalAccountId: event.externalAccountId,
      });
      return;
    }

    const applied = await templateService.applyStatusUpdate({
      account,
      name: event.name,
      language: event.language,
      providerStatus: event.providerStatus,
      reason: event.reason,
      providerCategory: event.providerCategory,
    });
    if (!applied) {
      // Ordinary the first time a client creates a template in WhatsApp Manager: the approval
      // webhook lands before any sync has mirrored the row. The hourly sync picks it up.
      logger.info('commerce webhook: template event matched no mirrored template yet', {
        orgId: account.orgId,
        name: event.name,
        language: event.language,
      });
    }
  }
}

/**
 * Meta's `wa_id` is E.164 without the leading '+'. Restoring it is a formatting change, not a guess.
 * Platforms that expose no number get null — an honest absence, not an invented value.
 */
function toE164(platform: CommercePlatform, externalId: string): string | null {
  if (platform !== 'whatsapp_cloud') return null;
  return /^\d{7,15}$/.test(externalId) ? `+${externalId}` : null;
}

export const commerceInboundService = new CommerceInboundService();
