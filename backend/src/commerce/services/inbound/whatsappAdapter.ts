import { z } from 'zod';
import type { CommerceMessageStatus, MessagePricingCategory } from '@stewra/shared-types';
import { MESSAGE_PRICING_CATEGORIES } from '@stewra/shared-types';
import type {
  InboundAdapter,
  NormalizedDeliveryReceipt,
  NormalizedInboundMessage,
  NormalizedTemplateEvent,
} from './types.js';

/**
 * One `entry[]` element of Meta's WhatsApp webhook envelope.
 *
 * Almost everything is optional by shape, because the same subscription delivers inbound messages,
 * delivery receipts (`statuses[]`), template status updates and account notifications. A payload
 * carrying only one of those is ordinary traffic. Arrays are batched — Meta packs several messages
 * into one POST — so nothing here indexes `[0]`.
 */
const entrySchema = z.object({
  // The WABA id. This is the tenant key, so it is required: an entry without it cannot be routed to
  // any organization and must not be guessed into one.
  id: z.string().min(1),
  changes: z
    .array(
      z.object({
        // Which subscription field this change belongs to: `messages` for traffic,
        // `message_template_status_update` and `message_template_category_update` for templates.
        field: z.string().optional(),
        value: z.object({
          contacts: z
            .array(
              z.object({
                wa_id: z.string(),
                profile: z.object({ name: z.string() }).partial().optional(),
              }),
            )
            .optional(),
          messages: z
            .array(
              z.object({
                id: z.string(),
                from: z.string(),
                // Meta sends a unix-seconds string.
                timestamp: z.string().optional(),
                type: z.string(),
                text: z.object({ body: z.string() }).optional(),
                // Present only on the first message of a conversation that started at a
                // click-to-WhatsApp ad or a Facebook post. Every field optional because Meta
                // populates them per source type — a post has no headline, an organic entry point
                // has no click id — and a referral dropped for a missing field it was never going
                // to carry is attribution lost permanently: it rides on this message alone.
                referral: z
                  .object({
                    source_type: z.string().optional(),
                    source_id: z.string().optional(),
                    source_url: z.string().optional(),
                    headline: z.string().optional(),
                    ctwa_clid: z.string().optional(),
                  })
                  .optional(),
              }),
            )
            .optional(),
          statuses: z
            .array(
              z.object({
                id: z.string(),
                status: z.string(),
                timestamp: z.string().optional(),
                recipient_id: z.string().optional(),
                conversation: z.object({ id: z.string().optional() }).partial().optional(),
                pricing: z
                  .object({
                    billable: z.boolean().optional(),
                    pricing_model: z.string().optional(),
                    category: z.string().optional(),
                  })
                  .optional(),
                errors: z
                  .array(
                    z.object({
                      code: z.number().optional(),
                      title: z.string().optional(),
                      message: z.string().optional(),
                      error_data: z.object({ details: z.string().optional() }).optional(),
                    }),
                  )
                  .optional(),
              }),
            )
            .optional(),
          // The template webhooks. Both live under `value` with no wrapper, distinguished by
          // `field` above and by which of these keys is present.
          event: z.string().optional(),
          message_template_name: z.string().optional(),
          message_template_language: z.string().optional(),
          reason: z.string().optional(),
          new_category: z.string().optional(),
        }),
      }),
    )
    .optional(),
});

/** Meta's timestamps are unix SECONDS as a string. A malformed one falls back to now, not to 1970. */
function parseTimestamp(raw: string | undefined): Date {
  if (raw === undefined) return new Date();
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return new Date();
  return new Date(seconds * 1000);
}

/**
 * Meta's delivery-status word → ours, or null for one this build has not met.
 *
 * Null makes the receipt undeliverable rather than mislabelled: `applyDeliveryStatus` enforces that
 * status never goes backwards, so writing a guessed value for a word Meta invents later (`warning`,
 * say) could freeze a message's real progression. The caller drops a null with a warning instead.
 */
function mapDeliveryStatus(providerStatus: string): CommerceMessageStatus | null {
  switch (providerStatus.toLowerCase()) {
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'read':
      return 'read';
    case 'failed':
      return 'failed';
    default:
      return null;
  }
}

/**
 * Meta's pricing-category word → ours, or null for one this build cannot name.
 *
 * Never a stand-in: the category is a rate. A receipt whose category maps to null still records its
 * `billable` flag and Meta's verbatim word, so the charge is counted (under
 * `billableUncategorized`) rather than silently rounded into a category it was not billed at.
 */
function mapPricingCategory(providerCategory: string): MessagePricingCategory | null {
  const known = providerCategory.toLowerCase();
  return MESSAGE_PRICING_CATEGORIES.find((category) => category === known) ?? null;
}

/** Meta's `errors[]` flattened into one human-readable line, or null when there were none. */
function describeReceiptErrors(
  errors:
    | Array<{
        code?: number | undefined;
        title?: string | undefined;
        message?: string | undefined;
        error_data?: { details?: string | undefined } | undefined;
      }>
    | undefined,
): string | null {
  if (errors === undefined || errors.length === 0) return null;
  const parts = errors.map((e) => {
    const words = [e.title ?? e.message, e.error_data?.details].filter(
      (word): word is string => word !== undefined && word.length > 0,
    );
    const text = words.join(' — ');
    if (e.code !== undefined) return text.length > 0 ? `${e.code}: ${text}` : String(e.code);
    return text;
  });
  const joined = parts.filter((part) => part.length > 0).join('; ');
  return joined.length > 0 ? joined : null;
}

export const whatsappInboundAdapter: InboundAdapter = {
  platform: 'whatsapp_cloud',

  normalize(rawEntry: unknown): NormalizedInboundMessage[] {
    const parsed = entrySchema.safeParse(rawEntry);
    // An unrecognised entry is not an error to raise at the caller: the endpoint must still 200 or
    // Meta retries it for a week. The controller logs the drop; this just yields nothing.
    if (!parsed.success) return [];

    const out: NormalizedInboundMessage[] = [];
    for (const change of parsed.data.changes ?? []) {
      // `contacts[]` carries the sender's profile name, keyed by wa_id, alongside the messages.
      const names = new Map(
        (change.value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name ?? null]),
      );

      for (const message of change.value.messages ?? []) {
        out.push({
          platform: 'whatsapp_cloud',
          externalAccountId: parsed.data.id,
          externalContactId: message.from,
          contactDisplayName: names.get(message.from) ?? null,
          providerMessageId: message.id,
          // Media arrives with no `text`. Null here rather than an empty string so the inbox can say
          // "sent a photo" instead of showing a blank message that reads as a bug.
          text: message.type === 'text' ? message.text?.body ?? null : null,
          messageType: message.type,
          referral:
            message.referral === undefined
              ? null
              : {
                  sourceType: message.referral.source_type ?? null,
                  sourceId: message.referral.source_id ?? null,
                  sourceUrl: message.referral.source_url ?? null,
                  headline: message.referral.headline ?? null,
                  ctwaClid: message.referral.ctwa_clid ?? null,
                },
          sentAt: parseTimestamp(message.timestamp),
        });
      }
    }
    return out;
  },

  normalizeReceipts(rawEntry: unknown): NormalizedDeliveryReceipt[] {
    const parsed = entrySchema.safeParse(rawEntry);
    if (!parsed.success) return [];

    const out: NormalizedDeliveryReceipt[] = [];
    for (const change of parsed.data.changes ?? []) {
      for (const status of change.value.statuses ?? []) {
        const mapped = mapDeliveryStatus(status.status);
        // A status word this build has not met. There is nothing safe to write — inventing one
        // could freeze the message's real progression under the never-goes-backwards rule — so the
        // receipt is dropped here and the controller logs what Meta actually said.
        if (mapped === null) continue;

        const pricing = status.pricing;
        out.push({
          platform: 'whatsapp_cloud',
          externalAccountId: parsed.data.id,
          providerMessageId: status.id,
          status: mapped,
          failureReason: mapped === 'failed' ? describeReceiptErrors(status.errors) : null,
          pricingCategory:
            pricing?.category === undefined ? null : mapPricingCategory(pricing.category),
          providerCategory: pricing?.category ?? null,
          pricingModel: pricing?.pricing_model ?? null,
          // Absent pricing block → null (nothing billed yet), which is distinct from an explicit
          // `billable: false` (Meta said this one is free). See NormalizedDeliveryReceipt.
          billable: pricing === undefined ? null : pricing.billable ?? null,
          providerConversationId: status.conversation?.id ?? null,
        });
      }
    }
    return out;
  },

  normalizeTemplateEvents(rawEntry: unknown): NormalizedTemplateEvent[] {
    const parsed = entrySchema.safeParse(rawEntry);
    if (!parsed.success) return [];

    const out: NormalizedTemplateEvent[] = [];
    for (const change of parsed.data.changes ?? []) {
      const value = change.value;
      // Both template webhooks name the template the same way; which one this is shows in `field`.
      // An entry without a template name is ordinary message traffic, not a malformed event.
      if (value.message_template_name === undefined) continue;
      if (value.message_template_language === undefined) continue;

      const isStatusEvent = change.field === 'message_template_status_update';
      const isCategoryEvent = change.field === 'message_template_category_update';
      if (!isStatusEvent && !isCategoryEvent) continue;

      out.push({
        platform: 'whatsapp_cloud',
        externalAccountId: parsed.data.id,
        name: value.message_template_name,
        language: value.message_template_language,
        // A status-update's word rides in `event` (APPROVED, PAUSED, …); a category event carries
        // none, and null here is what stops applyStatus from inventing one.
        providerStatus: isStatusEvent ? value.event ?? null : null,
        reason: isStatusEvent ? value.reason ?? null : null,
        providerCategory: isCategoryEvent ? value.new_category ?? null : null,
      });
    }
    return out;
  },
};
