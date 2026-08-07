import type {
  CommerceMessageStatus,
  CommercePlatform,
  MessagePricingCategory,
} from '@stewra/shared-types';

/**
 * One inbound message, flattened out of whatever envelope its platform uses.
 *
 * The point of this shape is that everything downstream — dedup, tenant routing, the inbox, and
 * later the intent layer — is written once against it. Adding Instagram or Messenger then becomes a
 * single adapter file rather than a second controller with its own copy of the routing rules.
 */
export interface NormalizedInboundMessage {
  readonly platform: CommercePlatform;
  /**
   * The platform's id for the ACCOUNT that received this — a WABA id for WhatsApp. This is the only
   * field that says which organization the message belongs to; the webhook is one URL for every
   * tenant, so routing depends entirely on it.
   */
  readonly externalAccountId: string;
  /** The platform's id for the sender — Meta's `wa_id`, an E.164 number without the '+'. */
  readonly externalContactId: string;
  /** The profile name the platform reported, when it reported one. */
  readonly contactDisplayName: string | null;
  /** The platform's message id (`wamid...`). The idempotency key against Meta's 7-day retries. */
  readonly providerMessageId: string;
  /**
   * The text. Null for a media message, which is carried as a placeholder rather than dropped — a
   * customer who sends a photo must still appear in the inbox, not vanish.
   */
  readonly text: string | null;
  /** What the platform called the message type (`text`, `image`, `audio`, …), for the placeholder. */
  readonly messageType: string;
  readonly sentAt: Date;
}

/**
 * What a platform said happened to a message WE sent — and what it charged for it.
 *
 * This is the only place a cost ever comes from. Stewra bills a client what Meta charged, so the
 * pricing fields are recorded exactly as reported rather than derived from the template's category:
 * a locally-computed category that disagreed with Meta's would make every billing dispute
 * unresolvable, because there would be no way to tell which number was the real one.
 */
export interface NormalizedDeliveryReceipt {
  readonly platform: CommercePlatform;
  /** The WABA id — the tenant key, the same one an inbound message routes by. */
  readonly externalAccountId: string;
  /** The id the send returned. What this receipt is reconciled against. */
  readonly providerMessageId: string;
  /** `sent` | `delivered` | `read` | `failed`. Never goes backwards; see `applyDeliveryStatus`. */
  readonly status: CommerceMessageStatus;
  /** Meta's reason, when it failed. Null on every other status. */
  readonly failureReason: string | null;
  /** Meta's category mapped onto ours, or `unknown` for one this build has not met. */
  readonly pricingCategory: MessagePricingCategory | null;
  /** Meta's word for the category, verbatim, so an `unknown` is explainable. */
  readonly providerCategory: string | null;
  /** Meta's pricing model — `CBP` under conversation pricing, `PMP` per-message. */
  readonly pricingModel: string | null;
  /**
   * Three-valued on purpose. `null` means the receipt carried no pricing block at all — nothing has
   * been billed yet; `false` means Meta explicitly said this one is free. Collapsing them under-bills
   * everything still in flight when a billing period closes.
   */
  readonly billable: boolean | null;
  /** Meta's conversation id, which is the unit CBP bills. Null under per-message pricing. */
  readonly providerConversationId: string | null;
}

/**
 * A change Meta made to one of an account's templates, pushed rather than polled.
 *
 * Status and category arrive on SEPARATE events and each omits the other, which is why both are
 * nullable here. Flattening them into one required pair would mean inventing whichever the event did
 * not carry — and inventing a status is how a re-categorization silently un-approves a template.
 */
export interface NormalizedTemplateEvent {
  readonly platform: CommercePlatform;
  readonly externalAccountId: string;
  readonly name: string;
  readonly language: string;
  /** Meta's status word (`APPROVED`, `PAUSED`, …). Null on a category-only event. */
  readonly providerStatus: string | null;
  /** Meta's rejection reason, when it gave one. */
  readonly reason: string | null;
  /** Meta's new category. Null on a status-only event. */
  readonly providerCategory: string | null;
}

/**
 * Turns one platform's raw webhook entry into the three things that entry can contain.
 *
 * Every method takes `unknown` deliberately: this is a remote service's payload arriving at an
 * unauthenticated endpoint, so each adapter validates it rather than being handed a type someone
 * asserted. An entry a method does not recognise yields an empty array — one POST from Meta commonly
 * carries only one of the three, and the other two returning nothing is normal traffic, not an error.
 */
export interface InboundAdapter {
  readonly platform: CommercePlatform;
  normalize(rawEntry: unknown): NormalizedInboundMessage[];
  normalizeReceipts(rawEntry: unknown): NormalizedDeliveryReceipt[];
  normalizeTemplateEvents(rawEntry: unknown): NormalizedTemplateEvent[];
}
