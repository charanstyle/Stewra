import type { ISODateString, JsonObject, UUID } from '../common/base';

/**
 * A COMMERCE PLATFORM is an external messaging surface an organization reaches its own customers on.
 *
 * Deliberately a separate union from `MessagingChannel` (models/channel.ts), which is about how a
 * Stewra USER reaches their own assistant. The two look similar and mean opposite things: a
 * `MessagingChannel` carries a user's private turn to Stewra, a `CommercePlatform` carries an
 * organization's message to a member of the public. Merging them would let a change to one silently
 * widen the other.
 *
 * `whatsapp_cloud` is the only platform that permits BUSINESS-INITIATED sends (via approved
 * templates). `instagram` and `messenger` are reply-only: Meta allows a message solely inside the
 * 24-hour window opened by the customer writing first. Any campaign feature must therefore treat
 * WhatsApp as the outbound channel and the other two as inbox-only, not as interchangeable options.
 */
export const COMMERCE_PLATFORMS = ['whatsapp_cloud', 'instagram', 'messenger'] as const;

/** Derived from the list above, so the runtime values and the type can never drift apart. */
export type CommercePlatform = (typeof COMMERCE_PLATFORMS)[number];

/** Platforms Stewra can currently send an outbound, business-initiated message on. */
export const OUTBOUND_CAPABLE_PLATFORMS: readonly CommercePlatform[] = ['whatsapp_cloud'];

export const CHANNEL_ACCOUNT_STATUSES = ['active', 'revoked', 'error'] as const;

export type ChannelAccountStatus = (typeof CHANNEL_ACCOUNT_STATUSES)[number];

/**
 * One external messaging account an organization has connected — e.g. a WhatsApp Business Account
 * and the phone number under it that Stewra sends from.
 *
 * This is what replaces the deploy-wide `WHATSAPP_*` env vars for the commerce plane: credentials
 * are per-organization, held in the vault, and referenced here only by opaque handle. That handle is
 * NOT part of this model — it never crosses the API boundary, exactly as a vault ref never reaches
 * the agent runtime.
 */
export interface ChannelAccount {
  readonly id: UUID;
  readonly orgId: UUID;
  readonly platform: CommercePlatform;
  /**
   * The platform's own id for the account: a WhatsApp Business Account (WABA) id, or an Instagram
   * business account id. This is the key an inbound webhook is routed by, so it is unique across
   * the whole install — one WABA belongs to exactly one organization.
   */
  readonly externalAccountId: string;
  /**
   * The specific sending identity under that account — for WhatsApp, the phone number id that
   * `/{phone-number-id}/messages` is posted to. Null for platforms where the account IS the sender.
   */
  readonly phoneNumberId: string | null;
  /** The customer-visible name/number, for display in the channel list. Never trusted for routing. */
  readonly displayName: string;
  readonly status: ChannelAccountStatus;
  /**
   * Why the account is in `error`, in plain language, for the reconnect prompt. Null when healthy.
   * A revoked grant must SAY it was revoked — a channel that silently stops sending is the failure
   * mode this field exists to prevent.
   */
  readonly errorDetail: string | null;
  /**
   * When the stored credential stops working, or null when it has no expiry.
   *
   * Meta's Embedded Signup configurations that grant the full WhatsApp management permission set
   * issue a token that dies after 60 days, so for most connected accounts this is a real date and a
   * real deadline. It is on the API model rather than kept server-side because the only recovery is
   * the client re-running Meta's dialog — a deadline nobody is shown is a channel that stops sending
   * without warning, which is the same failure `errorDetail` exists to prevent, one step earlier.
   */
  readonly credentialExpiresAt: ISODateString | null;
  readonly connectedAt: ISODateString;
}

/**
 * A person an organization is talking to on a platform — a member of the public, not a Stewra user.
 *
 * Distinct from `Contact` in models/contact.ts, which is a reciprocal edge between two Stewra
 * accounts and gates DMs and calls. This one has no account, never logs in, and exists because they
 * messaged a business or came in from an ad.
 */
export interface CommerceContact {
  readonly id: UUID;
  readonly orgId: UUID;
  readonly platform: CommercePlatform;
  /** The platform-side id: for WhatsApp, Meta's `wa_id` — an E.164 phone number without the '+'. */
  readonly externalId: string;
  /** The profile name the platform reported, when it reported one. */
  readonly displayName: string | null;
  /** E.164 WITH the '+', for display and for export. Null on platforms that expose no number. */
  readonly phoneE164: string | null;
  readonly attributes: ContactAttributes;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
}

/**
 * The client's own fields on a contact — plan, city, last order, whatever their business is about.
 *
 * String values only, and that is a real constraint rather than laziness. Every segment rule compares
 * these as text (`attributes->>'key'`), so a stored number would advertise an ordering the segment
 * compiler does not provide: `plan_value > 100` would silently become a string comparison where
 * "1000" sorts before "99". Typed fields with real range rules are a later refinement; until then the
 * type says exactly what can be relied on.
 *
 * Flat, for the same reason: a nested document would suggest a depth no rule can address.
 */
export interface ContactAttributes {
  readonly [key: string]: string;
}

/**
 * One thread between an organization and a contact, on one channel account.
 *
 * `serviceWindowExpiresAt` is load-bearing rather than decorative: outside it, Meta rejects
 * free-form messages and only an approved template will send — at a per-message cost. The inbox has
 * to show the agent how long they have, or they write a reply that silently cannot be delivered.
 */
export interface CommerceConversation {
  readonly id: UUID;
  readonly orgId: UUID;
  readonly channelAccountId: UUID;
  readonly contactId: UUID;
  readonly platform: CommercePlatform;
  readonly lastMessageAt: ISODateString | null;
  /** When the 24-hour customer-service window closes. Null when no inbound has ever opened one. */
  readonly serviceWindowExpiresAt: ISODateString | null;
  readonly createdAt: ISODateString;
}

/** A conversation plus the denormalized contact fields a list view needs, so listing is one query. */
export interface CommerceConversationSummary extends CommerceConversation {
  readonly contactDisplayName: string | null;
  readonly contactPhoneE164: string | null;
  /** First line of the most recent message, for the list preview. Empty when the thread is empty. */
  readonly lastMessagePreview: string;
}

export const COMMERCE_MESSAGE_DIRECTIONS = ['inbound', 'outbound'] as const;

export type CommerceMessageDirection = (typeof COMMERCE_MESSAGE_DIRECTIONS)[number];

/**
 * Delivery state of an outbound message. `queued` and `failed` both exist because a send that never
 * left is a different fact from one the platform rejected, and an operator needs to tell them apart.
 * Inbound messages are always `delivered`.
 */
export const COMMERCE_MESSAGE_STATUSES = [
  'queued',
  'sent',
  'delivered',
  'read',
  'failed',
] as const;

export type CommerceMessageStatus = (typeof COMMERCE_MESSAGE_STATUSES)[number];

/**
 * What an organization is permitted to message a contact ABOUT.
 *
 * Two purposes rather than one boolean, because the two are earned differently and consenting to one
 * is not consenting to the other. `service` is opened by the customer writing first — they asked a
 * question, so answering it is what they wanted. `marketing` has to be given deliberately, in advance,
 * and is what regulators, Meta's own policy, and the person's patience are all actually about.
 *
 * Collapsing these into a single "consented" flag is the most common way a compliant integration
 * quietly becomes a non-compliant one: every inbound question would read as permission to promote.
 */
export const CONSENT_PURPOSES = ['service', 'marketing'] as const;

export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

export const CONSENT_STATES = ['opted_in', 'opted_out'] as const;

export type ConsentState = (typeof CONSENT_STATES)[number];

/**
 * How a consent record came to exist — i.e. what the organization can actually show if challenged.
 *
 * The first three are self-evidencing: the customer's own action is the proof, and Stewra recorded it
 * as it happened. `import` and `attested` rest on the organization's word instead. They are kept
 * distinguishable rather than flattened because "they wrote to us" and "they told us they had a list"
 * are not the same defence, and a schema that stores them identically has thrown away the difference
 * before anyone needs it.
 */
export const CONSENT_SOURCES = [
  'inbound_message',
  'keyword',
  'ad_click',
  'web_form',
  'import',
  'attested',
] as const;

export type ConsentSource = (typeof CONSENT_SOURCES)[number];

/**
 * One immutable entry in a contact's consent history.
 *
 * Never updated — opting out appends a new row. The history is the point: a message sent in March has
 * to be defensible against what was on file in March, and a table that overwrites cannot answer that.
 */
export interface ContactConsent {
  readonly id: UUID;
  readonly orgId: UUID;
  readonly contactId: UUID;
  readonly platform: CommercePlatform;
  readonly purpose: ConsentPurpose;
  readonly state: ConsentState;
  readonly source: ConsentSource;
  /** The proof, verbatim: a `wamid`, a form URL, an ad id, an import filename. Never empty. */
  readonly evidence: string;
  /** Which member recorded it. Null when the customer's own action created the row. */
  readonly recordedByUserId: UUID | null;
  readonly recordedAt: ISODateString;
}

export const SUPPRESSION_REASONS = [
  'opt_out',
  'complaint',
  'undeliverable',
  'blocked_by_platform',
  'manual',
] as const;

export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/**
 * An address an organization may not message, for any purpose, until it is explicitly lifted.
 *
 * Keyed on the platform ADDRESS rather than on a contact id: contact rows get deleted and re-imported
 * from fresh lists, and a block that followed the row would evaporate the moment someone re-uploaded
 * a spreadsheet. The phone number is what the person actually owns, so it is what the block follows.
 */
export interface Suppression {
  readonly id: UUID;
  readonly orgId: UUID;
  readonly platform: CommercePlatform;
  /** The platform-side address — Meta's `wa_id`, matching `CommerceContact.externalId`. */
  readonly externalId: string;
  readonly reason: SuppressionReason;
  readonly detail: string | null;
  readonly createdAt: ISODateString;
}

/**
 * An organization's messaging policy: when it may send, and its signed statement that it may at all.
 *
 * The absence of this record is meaningful and is every organization's starting state — no policy
 * means no marketing send, full stop. There is no permissive default anywhere in this feature, which
 * is deliberate: "we could not find a policy, so we sent it" is precisely the outcome the record
 * exists to make impossible.
 */
export interface MessagingPolicy {
  readonly orgId: UUID;
  /**
   * The IANA zone quiet hours are evaluated in — the ORGANIZATION's declared zone, not each
   * recipient's. Recipient-local quiet hours would need per-contact timezone data Stewra does not
   * have; declaring one zone is the honest version of what can actually be enforced today.
   */
  readonly timezone: string;
  /** Local wall-clock `HH:MM` bounds of the window in which marketing sends are NOT permitted. */
  readonly quietHoursStart: string;
  readonly quietHoursEnd: string;
  /** When a member attested to lawful opt-in. Null until one has — and until then, no broadcast. */
  readonly attestedAt: ISODateString | null;
  readonly attestedByUserId: UUID | null;
  /** The exact sentence that member accepted, stored verbatim so a later rewording cannot rewrite it. */
  readonly attestationText: string | null;
  readonly updatedAt: ISODateString;
}

/**
 * What Meta says it CHARGED for a message, in its own words.
 *
 * Reported on the delivery status webhook, never decided by us. The list is Meta's, including the
 * ones we would not otherwise model: `referral_conversion` is free and arrives on messages that
 * started from a Click-to-WhatsApp ad, and `service` is free until 2026-10-01 and billable after.
 *
 * There is deliberately NO `unknown` member. Meta adds categories — `authentication_international`
 * appeared in 2024 — and a build that meets one it has never heard of must not invent a category the
 * client is then invoiced under. It records `pricingCategory: null` and keeps Meta's raw word in
 * {@link MessageCostAttribution.providerCategory}, which loses nothing: `billable` says whether the
 * message was charged for, so "charged under a category we cannot name" stays fully distinguishable
 * from "no receipt has arrived", and the cost summary counts it under `billableUncategorized` rather
 * than dropping it. This is the opposite call from {@link TEMPLATE_STATUSES}, and for a reason —
 * `unknown` there is a REFUSAL to send, which is safe; here it would be a number on an invoice.
 */
export const MESSAGE_PRICING_CATEGORIES = [
  'marketing',
  'utility',
  'authentication',
  'service',
  'referral_conversion',
] as const;

export type MessagePricingCategory = (typeof MESSAGE_PRICING_CATEGORIES)[number];

/**
 * What one delivered message cost, attributed to the organization that sent it.
 *
 * Every field here comes from Meta's status webhook rather than from our own expectation of what a
 * send should have cost. That distinction is the whole point: Stewra bills the client what Meta
 * charged, so the number on the invoice has to be the number Meta reported, and a locally-derived
 * one would make every disagreement unresolvable.
 *
 * All of it is null until the status webhook lands, which is an honest "not yet known" rather than
 * a zero — a message queued at 09:00 and priced at 09:00:02 is not a free message for two seconds.
 */
export interface MessageCostAttribution {
  readonly pricingCategory: MessagePricingCategory | null;
  /** Meta's raw `pricing.category`, kept verbatim so a category we do not model is still readable. */
  readonly providerCategory: string | null;
  /** Meta's `pricing.pricing_model` — `CBP`, `PMP`, and whatever replaces them. */
  readonly pricingModel: string | null;
  /**
   * Whether Meta says this one is chargeable. Explicitly three-valued: `null` means the webhook has
   * not arrived, `false` means Meta said it is free. Collapsing those would report an unpriced
   * message as a free one and under-bill every send still in flight at the end of a billing period.
   */
  readonly billable: boolean | null;
  /**
   * Meta's conversation id. Recorded even though pricing went per-message on 2025-07-01, because
   * service messages stay conversation-priced until 2026-10-01 — without it, several free replies
   * inside one paid conversation cannot be told apart from several separate charges.
   */
  readonly providerConversationId: string | null;
}

/** One message in a commerce conversation, in either direction. */
export interface CommerceMessage {
  readonly id: UUID;
  readonly orgId: UUID;
  readonly conversationId: UUID;
  readonly direction: CommerceMessageDirection;
  readonly platform: CommercePlatform;
  /** The platform's own message id (`wamid...`). Null while an outbound send is still queued. */
  readonly providerMessageId: string | null;
  readonly body: string;
  readonly status: CommerceMessageStatus;
  /** Why a `failed` message failed, verbatim from the platform. Null otherwise. */
  readonly failureReason: string | null;
  /** Which member sent it, for outbound. Null for inbound and for automated sends. */
  readonly sentByUserId: UUID | null;
  /** The approved template this was sent from, when it was a template send. Null for free-form. */
  readonly templateId: UUID | null;
  /** What Meta charged. Every field null until the delivery webhook says otherwise. */
  readonly cost: MessageCostAttribution;
  readonly createdAt: ISODateString;
}

/**
 * A hand-applied label on a contact. The name is what people type, so identity ignores its case —
 * "VIP" and "vip" as two separate tags splits an audience in half and reports nothing wrong.
 */
export interface CommerceTag {
  readonly id: UUID;
  readonly orgId: UUID;
  readonly name: string;
  /** How many contacts currently carry it. Present on list responses; the reason anyone opens the page. */
  readonly contactCount: number;
  readonly createdAt: ISODateString;
}

export const SEGMENT_MATCH_MODES = ['all', 'any'] as const;

/** Whether every rule must hold, or any one of them. There is no nesting — see `SegmentDefinition`. */
export type SegmentMatchMode = (typeof SEGMENT_MATCH_MODES)[number];

/**
 * One predicate in a segment.
 *
 * A discriminated union rather than a `{field, op, value}` triple, so the cases where a value is
 * meaningless cannot carry one: `exists` has no value to compare against, and `never` is not a date.
 * A shape that made `value` optional everywhere would let `{op: 'eq'}` with no value typecheck, and
 * that rule would then match either everyone or no one depending on how the compiler read it.
 *
 * Note what is absent: there is no rule about suppression. The send path applies the suppression list
 * to every recipient however they were selected, and a predicate that could mention it is a predicate
 * that could invert it.
 */
export type SegmentRule =
  /** Carries (or does not carry) a tag, matched by name, case-insensitively. */
  | { readonly type: 'tag'; readonly op: 'has' | 'not_has'; readonly tag: string }
  /** A client-defined field on the contact, compared as text. */
  | {
      readonly type: 'attribute';
      readonly key: string;
      readonly op: 'eq' | 'neq' | 'contains';
      readonly value: string;
    }
  /** Whether the field is set at all — distinct from being set to an empty string. */
  | { readonly type: 'attribute'; readonly key: string; readonly op: 'exists' | 'not_exists' }
  /**
   * The consent currently on file for one purpose. `none` means nothing was ever recorded, which is
   * NOT the same as `opted_out` and is kept separate here for the same reason it is in the table: an
   * operator building a re-permission campaign is targeting exactly the people nobody ever asked.
   */
  | {
      readonly type: 'consent';
      readonly purpose: ConsentPurpose;
      readonly state: ConsentState | 'none';
    }
  | { readonly type: 'platform'; readonly value: CommercePlatform }
  | { readonly type: 'created'; readonly op: 'before' | 'after'; readonly value: ISODateString }
  /** Against the newest message in any of the contact's threads. */
  | {
      readonly type: 'last_message';
      readonly op: 'before' | 'after';
      readonly value: ISODateString;
    }
  /** Has never sent or received anything — an imported contact nobody has spoken to. */
  | { readonly type: 'last_message'; readonly op: 'never' };

/**
 * The saved rule a segment IS.
 *
 * Flat rather than a nested boolean tree. Arbitrary nesting is easy to store and hard to display,
 * and a rule nobody can read in the UI is a rule whose audience nobody can predict — which for a
 * feature that sends messages to the public is the wrong thing to be clever about. `all`/`any` over a
 * flat list covers what campaigns actually ask for; nesting can be added when a real one needs it.
 */
export interface SegmentDefinition {
  readonly match: SegmentMatchMode;
  readonly rules: readonly SegmentRule[];
}

/**
 * A named, saved audience rule. It stores the RULE, never the resulting member list.
 *
 * A materialized list is a photograph of consent taken at a moment nobody remembers: the person who
 * opted out on Tuesday is still in Monday's snapshot, and a send that used it was authorized by a
 * fact that had already stopped being true. Recomputing from the rule is the only version that stays
 * correct without anyone maintaining it.
 */
export interface CommerceSegment {
  readonly id: UUID;
  readonly orgId: UUID;
  readonly name: string;
  readonly description: string | null;
  readonly definition: SegmentDefinition;
  readonly createdByUserId: UUID | null;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
}

/**
 * Why one selected contact could not actually be sent to.
 *
 * Per-CONTACT reasons only. Quiet hours and the missing attestation block the whole organization and
 * are reported separately — folding them in would show every contact as individually blocked for a
 * reason that has nothing to do with them, and hide the one setting that would fix all of them.
 */
export const AUDIENCE_BLOCK_REASONS = [
  'suppressed',
  'no_marketing_consent',
  'marketing_opted_out',
  /** Selected on a platform that permits no business-initiated send at all — Instagram, Messenger. */
  'platform_inbound_only',
] as const;

export type AudienceBlockReason = (typeof AUDIENCE_BLOCK_REASONS)[number];

/** One contact a segment selected, with whether marketing may actually reach them right now. */
export interface AudienceMember {
  readonly contactId: UUID;
  readonly platform: CommercePlatform;
  readonly externalId: string;
  readonly displayName: string | null;
  readonly phoneE164: string | null;
  /** Null when this contact is sendable. */
  readonly blockedReason: AudienceBlockReason | null;
}

/**
 * What a segment would actually reach, answered before anything is sent.
 *
 * `total` and `sendable` are reported separately on purpose. "1,240 contacts" next to a Send button
 * is the number a client budgets against and tells their boss; if 400 of them have no marketing
 * consent, discovering that from the delivery report afterwards is discovering it too late.
 */
export interface AudiencePreview {
  readonly total: number;
  readonly sendable: number;
  /** Counts per reason, every reason present even at zero, so a caller never reads absence as none. */
  readonly blocked: Record<AudienceBlockReason, number>;
  /**
   * A whole-organization block, or null. Reported apart from `blocked` because one settings change
   * clears it for every contact at once.
   *
   * Quiet hours are deliberately NOT evaluated here: they depend on when the send happens, and a
   * preview run at 22:00 for a broadcast scheduled at 09:00 would report a block that will not exist.
   */
  readonly orgBlockedReason: 'no_messaging_policy' | 'not_attested' | null;
  /** The first page of members, for the "who is in this" panel. Never the whole audience. */
  readonly sample: readonly AudienceMember[];
}

/**
 * What kinds of work the commerce job queue carries.
 *
 * A closed union rather than a free string, so a typo enqueues nothing instead of enqueueing a job
 * no handler will ever claim — which would sit at `queued` forever, looking like a backlog.
 *
 * `broadcast_dispatch` resolves an audience and materializes its recipients; `broadcast_send` walks
 * a batch of those recipients and sends to each. Two kinds rather than one because they fail
 * differently and must retry differently: re-running a dispatch re-reads the segment and adds nobody
 * twice, while re-running a send batch must never re-send to someone it already reached.
 */
export const COMMERCE_JOB_KINDS = [
  'channel_token_refresh',
  'template_sync',
  'broadcast_dispatch',
  'broadcast_send',
  'contact_import',
] as const;

export type CommerceJobKind = (typeof COMMERCE_JOB_KINDS)[number];

/**
 * Where a job is.
 *
 * `failed` and `dead` are both terminal and are NOT the same thing. `dead` means the queue tried
 * `max_attempts` times and gave up — a transient fault that never cleared. `failed` means the handler
 * said "do not try this again": the contact is suppressed, the org's consent was withdrawn, the
 * channel was disconnected. Retrying the first is diligence; retrying the second is the exact
 * behaviour the consent gate exists to prevent.
 */
export const COMMERCE_JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'dead'] as const;

export type CommerceJobStatus = (typeof COMMERCE_JOB_STATUSES)[number];

/**
 * What Meta bills a template under, and what it will let the template say.
 *
 * Not a label — the category decides the price and the rules. `marketing` is the expensive one and
 * the one that needs opt-in; `utility` covers a message about a transaction the customer already
 * has with the business; `authentication` is one-time passcodes and is rate-limited differently.
 * Meta re-categorizes templates on its own when it disagrees with the submission, which is why the
 * stored value is refreshed from Meta rather than trusted from the create request forever.
 *
 * No `unknown` member, for the same reason {@link MESSAGE_PRICING_CATEGORIES} has none. Meta has
 * reduced this vocabulary once already (the 2023 collapse of TRANSACTIONAL and OTP into these three)
 * and can extend it again; a category we do not recognize is recorded as
 * {@link MessageTemplate.category} `null`, with Meta's own word kept in
 * {@link MessageTemplate.providerCategory}. Mapping it onto the nearest one we know would put a
 * made-up rate into a client's cost forecast, and a null there is a forecast that says so.
 */
export const TEMPLATE_CATEGORIES = ['marketing', 'utility', 'authentication'] as const;

export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

/**
 * Where a template stands with Meta.
 *
 * Only `approved` may be sent. Everything else — including `paused`, which Meta applies on its own
 * when recipients report a template — is a refusal, and the send path treats them identically.
 *
 * `unknown` is the load-bearing member. Meta's status vocabulary is Meta's to extend, and a build
 * that meets a value it has never heard of has exactly two options: map it onto the nearest thing it
 * knows, or say it does not know. The first is how a template Meta has quietly flagged keeps being
 * sent. The raw string is preserved in {@link MessageTemplate.providerStatus}, so the operator sees
 * Meta's actual word for it while the send gate sees "not approved".
 */
export const TEMPLATE_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'paused',
  'disabled',
  'unknown',
] as const;

export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

/**
 * An approved message shape — the only thing WhatsApp will deliver outside the 24-hour window, and
 * therefore the only way a business-initiated campaign reaches anybody.
 *
 * Stewra does not own these. Meta does: it approves them, categorizes them, pauses them when
 * recipients complain, and deletes them. Every row here is a MIRROR of a template that lives at
 * Meta, kept current by a push (the `message_template_status_update` webhook) and a pull (the
 * `template_sync` job). Both exist because either alone fails silently: a missed webhook leaves a
 * paused template looking sendable, and a pull-only design leaves it looking sendable until the next
 * sweep.
 *
 * `variableCount` is derived from the body rather than declared, and it is the reason a broadcast can
 * be refused before it starts. A template reading `Hi {{1}}, your {{2}} is ready` sent with one
 * variable is rejected by Meta per recipient, mid-campaign, after some have already been messaged.
 */
export interface MessageTemplate {
  readonly id: UUID;
  readonly orgId: UUID;
  /** The WABA the template lives under. Templates are per-account, not per-organization. */
  readonly channelAccountId: UUID;
  /** Meta's name rules: lowercase, digits and underscores. Unique per account and language. */
  readonly name: string;
  /** BCP-47-ish, as Meta spells it: `en_US`, `pt_BR`. */
  readonly language: string;
  /** Null when Meta reported a category this build does not model — never guessed at. */
  readonly category: TemplateCategory | null;
  /** Meta's own category string, verbatim. What a null `category` was, in Meta's words. */
  readonly providerCategory: string | null;
  readonly status: TemplateStatus;
  /** Meta's own status string, verbatim, including ones this build does not model. */
  readonly providerStatus: string;
  /** Meta's template id. Null only for a row whose create call never reached Meta. */
  readonly providerTemplateId: string | null;
  readonly headerText: string | null;
  readonly bodyText: string;
  readonly footerText: string | null;
  /** How many `{{n}}` placeholders the body carries. Derived from `bodyText`, never declared. */
  readonly variableCount: number;
  /** Meta's reason for a rejection, when it gave one. */
  readonly rejectionReason: string | null;
  /** Meta's rolling quality signal for the template: GREEN | YELLOW | RED. */
  readonly qualityScore: string | null;
  /** When a sync or a webhook last confirmed this against Meta. Null means never — never sent. */
  readonly lastSyncedAt: ISODateString | null;
  readonly createdByUserId: UUID | null;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
}

export const BROADCAST_STATUSES = [
  /** Waiting for `scheduledFor`. Cancellable, editable, and reaching nobody yet. */
  'scheduled',
  /** Recipients are materialized and sends are in flight. */
  'running',
  /**
   * Stopped part-way and expecting to continue — quiet hours began, or a member paused it. The
   * recipients already sent to stay sent; the rest are still `pending`.
   */
  'paused',
  'completed',
  /** Stopped by a member and not resuming. Recipients not yet sent are abandoned, not queued. */
  'cancelled',
  /** Could not run at all: the channel was disconnected, the template stopped being approved. */
  'failed',
] as const;

export type BroadcastStatus = (typeof BROADCAST_STATUSES)[number];

/**
 * A scheduled, business-initiated send of one template to one segment.
 *
 * It stores the segment by REFERENCE and resolves the audience at DISPATCH time, not at schedule
 * time. That is the same argument as the segment itself, one level up: a broadcast written on Monday
 * for Friday morning that captured its recipient list on Monday would message four days of opt-outs.
 * The list a campaign sends to is the list its rule produces at the moment it runs.
 *
 * The counts are materialized because they are a report, not a rule — how many were reached is a
 * fact about the past that must not change when someone later edits the segment.
 */
export interface CommerceBroadcast {
  readonly id: UUID;
  readonly orgId: UUID;
  readonly channelAccountId: UUID;
  readonly name: string;
  readonly segmentId: UUID;
  readonly templateId: UUID;
  /** Positional fills for the template's `{{n}}` placeholders. Length must equal `variableCount`. */
  readonly variables: readonly string[];
  readonly status: BroadcastStatus;
  readonly scheduledFor: ISODateString;
  readonly startedAt: ISODateString | null;
  readonly completedAt: ISODateString | null;
  /** How many the segment selected when it was dispatched. Zero until then. */
  readonly totalRecipients: number;
  readonly sentCount: number;
  readonly failedCount: number;
  /** Selected, but not sendable — suppressed, no consent, opted out, inbound-only platform. */
  readonly skippedCount: number;
  /** Why the broadcast as a whole stopped, when it did. Per-recipient failures are on the recipient. */
  readonly lastError: string | null;
  readonly createdByUserId: UUID | null;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
}

/**
 * Per-recipient state.
 *
 * `sending` is not a decoration. A worker that dies between Meta accepting a send and the row being
 * updated leaves a recipient here, and that row is deliberately NOT retried — see
 * `broadcastSendHandler`. Sending a marketing message twice is a harm to a member of the public;
 * failing to send it once is a number in a report. The states are asymmetric because the outcomes
 * are.
 */
export const BROADCAST_RECIPIENT_STATUSES = [
  'pending',
  'sending',
  'sent',
  'failed',
  'skipped',
] as const;

export type BroadcastRecipientStatus = (typeof BROADCAST_RECIPIENT_STATUSES)[number];

/** One person a broadcast selected, and what actually happened to them. */
export interface BroadcastRecipient {
  readonly id: UUID;
  readonly orgId: UUID;
  readonly broadcastId: UUID;
  readonly contactId: UUID;
  /** The platform address, snapshotted — the contact row can be edited after the send. */
  readonly externalId: string;
  readonly displayName: string | null;
  readonly status: BroadcastRecipientStatus;
  /**
   * Why they were skipped or why the send failed, in words. An `AudienceBlockReason` for a skip, and
   * the platform's own error text for a failure — both in one column because an operator's question
   * is "why did this person not get it", not "which of two systems refused".
   */
  readonly reason: string | null;
  readonly providerMessageId: string | null;
  /** The message row this produced, which carries the cost attribution. Null unless sent. */
  readonly messageId: UUID | null;
  readonly sentAt: ISODateString | null;
}

/**
 * What a broadcast is going to cost, before it runs.
 *
 * Meta's own price list is not exposed by any API — the per-message rate depends on the recipient's
 * country and the template's category, and Meta publishes it as a spreadsheet. So this deliberately
 * does NOT carry a currency amount: an invented rate multiplied by a real audience is a number a
 * client would plan against, and being wrong about it is worse than not offering it.
 *
 * What it does carry is the two facts that are actually knowable: how many billable messages this
 * will send, and under which category they will be billed. That is the input to Meta's published
 * rate, and it is exactly what a client needs to look their own bill up against.
 */
export interface BroadcastCostForecast {
  readonly billableMessages: number;
  /** The template's category. Null when Meta reported one this build does not model. */
  readonly category: TemplateCategory | null;
  /** Recipients per country prefix, since Meta's rate is per-country. Keyed by E.164 country code. */
  readonly byCountryCode: Readonly<Record<string, number>>;
}

/**
 * What an organization was actually charged for, over a period, split the way Meta splits it.
 *
 * Counts of messages per pricing category, from the categories Meta REPORTED on each delivery — not
 * from the category of the template we sent. Those disagree more often than they should: Meta
 * re-categorizes templates, and a marketing template that a customer replied to first is billed as
 * a service message. The reported category is the one on the invoice.
 */
export interface CommerceCostSummary {
  readonly orgId: UUID;
  readonly from: ISODateString;
  readonly to: ISODateString;
  /** Every category present even at zero, so a caller never reads absence as none. */
  readonly billableByCategory: Readonly<Record<MessagePricingCategory, number>>;
  /**
   * Messages Meta charged for under a category this build does not model.
   *
   * Its own line rather than a bucket inside `billableByCategory`, because it is not a category — it
   * is the count of charges we can confirm happened and cannot yet name. Folding it into any real
   * category would misstate that category's volume; dropping it would understate the total. The raw
   * words are on the messages themselves, in `providerCategory`.
   */
  readonly billableUncategorized: number;
  /** Messages Meta explicitly said were free. */
  readonly freeMessages: number;
  /**
   * Sent messages with no pricing on file yet — the webhook has not arrived, or never will.
   *
   * Reported rather than folded into the free count. A billing period closed with a hundred of these
   * is a hundred messages the client will be charged for by Meta and not by us, and that is a
   * discrepancy someone has to see rather than a rounding difference.
   */
  readonly unpricedMessages: number;
}

/** One unit of background work owned by an organization. */
export interface CommerceJob {
  readonly id: UUID;
  readonly orgId: UUID;
  readonly kind: CommerceJobKind;
  readonly payload: JsonObject;
  readonly status: CommerceJobStatus;
  /** When this becomes eligible to run — both the schedule and the retry backoff. */
  readonly runAfter: ISODateString;
  readonly attempts: number;
  readonly maxAttempts: number;
  /** Why the most recent attempt failed. Retained after a later success, on purpose. */
  readonly lastError: string | null;
  /** Which worker holds the lease, and until when. Both null unless `status` is `running`. */
  readonly lockedBy: string | null;
  readonly lockedUntil: ISODateString | null;
  /** The enqueuer's idempotency key, when it had one. Unique per org across every state. */
  readonly dedupeKey: string | null;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
  /** When it reached a terminal state. Null while it is still queued or running. */
  readonly finishedAt: ISODateString | null;
}

/**
 * Where a contact import is.
 *
 * Deliberately NOT the job's own statuses. A job that is `dead` after five attempts and an import
 * that read a file it could not parse are the same state to a queue and different sentences to the
 * person who uploaded the file, and this is the status that gets shown to them.
 *
 * There is no `partial`. An import that imported nine hundred rows and skipped a hundred is `done` —
 * the hundred are not a failure of the import, they are its findings, and each one is a row in
 * {@link ContactImportRow} saying which row it was and why. `failed` is reserved for the import as a
 * whole not having happened: the file did not parse, or the queue gave up.
 */
export const CONTACT_IMPORT_STATUSES = ['queued', 'running', 'done', 'failed'] as const;

export type ContactImportStatus = (typeof CONTACT_IMPORT_STATUSES)[number];

/**
 * Why a row was not imported.
 *
 * A closed union rather than a free-text note, because this list is the answer to "why is my list
 * smaller than my file" and it has to be countable. Free text would make the report readable and the
 * summary impossible.
 *
 * `missing_consent` and `invalid_consent` are separate on purpose. The first means the row said
 * nothing about how this person agreed to be messaged; the second means it said something that is
 * not a thing we can record. The fix for one is "your export is missing a column" and for the other
 * is "that word is not one of the sources" — telling someone the wrong one costs them an afternoon.
 */
export const CONTACT_IMPORT_SKIP_REASONS = [
  'invalid_phone',
  'missing_consent',
  'invalid_consent',
  'invalid_attribute',
  'duplicate_in_file',
  'already_a_contact',
] as const;

export type ContactImportSkipReason = (typeof CONTACT_IMPORT_SKIP_REASONS)[number];

/** One uploaded file and what became of it. */
export interface ContactImport {
  readonly id: UUID;
  readonly orgId: UUID;
  /**
   * Who uploaded it, and therefore who the consent this import records is attributed to. Null only
   * once that user has been erased — an import whose uploader is gone is refused rather than run,
   * because consent evidence signed by nobody is not evidence.
   */
  readonly createdByUserId: UUID | null;
  /** What the operator called the file. Shown back to them; never used as a path. */
  readonly filename: string;
  readonly platform: CommercePlatform;
  readonly status: ContactImportStatus;
  /** Data rows in the file, excluding the header. Known from the moment it is accepted. */
  readonly totalRows: number;
  readonly importedCount: number;
  readonly skippedCount: number;
  /**
   * Why the import as a whole did not happen. Null unless `status` is `failed` — a `done` import
   * with skipped rows explains itself per row instead.
   */
  readonly error: string | null;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
  readonly finishedAt: ISODateString | null;
}

/**
 * What became of one row.
 *
 * Every processed row gets one of these, imported or not — this table IS the import's ledger, in the
 * same shape and for the same reason as `commerce_broadcast_recipients`. It is also what makes the
 * handler idempotent: a job whose lease expired half way is claimed again, and the rows already
 * written here are the record of how far it got.
 */
export interface ContactImportRow {
  readonly id: UUID;
  readonly importId: UUID;
  /** 1-based, counting data rows only, so it matches what the operator sees below their header. */
  readonly rowNumber: number;
  /** The phone exactly as the file wrote it — the only way to find the row again in their export. */
  readonly rawPhone: string;
  /** Null when the row was skipped, or when it named a contact that already existed. */
  readonly contactId: UUID | null;
  readonly imported: boolean;
  readonly skipReason: ContactImportSkipReason | null;
  /** The specific complaint, for a row the reason alone does not locate. */
  readonly detail: string | null;
}

export const OPTIN_LINK_STATUSES = ['active', 'disabled'] as const;
export type OptinLinkStatus = (typeof OPTIN_LINK_STATUSES)[number];

/**
 * A per-organization click-to-WhatsApp link that collects consent from the customer's own first
 * message.
 *
 * The mechanism is the point, and it is not the one Meta's `referral` block provides. Meta attaches
 * `referral` only to messages that began at an AD or a Facebook POST — a link a business prints on a
 * receipt or puts in its website footer produces an ordinary text message with no referral at all. So
 * the provenance has to travel in the only field that survives an arbitrary `wa.me` link: the
 * prefilled message text. Each link owns an unguessable {@link token} which is appended to that text,
 * and the inbound path matches it back.
 *
 * That indirection buys something better than attribution. The customer does not click a box on a
 * page we control and take our word for it afterwards; they send us a sentence, in their own account,
 * that says what they are agreeing to — and Meta keeps a copy. It is the same class of evidence as a
 * keyword opt-out, which is the strongest kind this system has.
 */
export interface OptinLink {
  readonly id: UUID;
  readonly orgId: UUID;
  /** The connected number the link opens a chat with. */
  readonly channelAccountId: UUID;
  /** What the operator calls it — "Receipt QR", "Website footer". Unique per organization. */
  readonly name: string;
  /**
   * What a customer arriving through this link is consenting to. A link that says "send me offers"
   * collects `marketing`; one that only opens a support chat collects `service` and grants nothing
   * the 24-hour window would not already give.
   */
  readonly purpose: ConsentPurpose;
  /**
   * The exact message the customer will send, token included. Immutable: the link is a published
   * artifact — printed on packaging, encoded in a QR — and editing the sentence after people have
   * begun agreeing to it would change what past opt-ins mean. Superseding it is a new link.
   */
  readonly prefillText: string;
  /** The unguessable marker inside {@link prefillText}. Matching this is how an opt-in is recognised. */
  readonly token: string;
  /** The full `https://wa.me/...?text=...` URL. Derived, never stored — the parts are the truth. */
  readonly url: string;
  readonly status: OptinLinkStatus;
  /** Consents recorded through this link. The honest answer to "is my link working?". */
  readonly optInCount: number;
  readonly createdByUserId: UUID | null;
  readonly createdAt: ISODateString;
  readonly disabledAt: ISODateString | null;
}
