// @skip-validation — this file IS the shared-types package. The api-contract guard requires a literal
// `@stewra/shared-types` import in any file declaring *Request/*Response types, which is unsatisfiable
// here (it would be a self-import); every sibling in this directory imports relatively for the same
// reason. Remove this marker if the guard ever learns to exclude packages/shared-types/.
import type {
  AudienceMember,
  AudiencePreview,
  BroadcastCostForecast,
  BroadcastRecipient,
  ChannelAccount,
  CommerceBroadcast,
  CommerceContact,
  CommerceConversationSummary,
  CommerceMessageRate,
  CommerceInvoice,
  CommerceInvoiceLine,
  CommerceMoneySummary,
  CommercePlan,
  CommercePlanVersion,
  CommerceRateCard,
  CommerceSpendCap,
  CommerceSpendUsage,
  CommerceSubscriptionView,
  MessagePricingCategory,
  RateUnit,
  CommerceCostSummary,
  CommerceJob,
  CommerceJobStatus,
  CommerceMessage,
  CommerceSegment,
  CommerceTag,
  ConsentPurpose,
  OptinLink,
  ConsentSource,
  ConsentState,
  ContactConsent,
  ContactImport,
  ContactImportRow,
  MessageTemplate,
  MessagingPolicy,
  SegmentDefinition,
  Suppression,
  SuppressionReason,
  TemplateCategory,
} from '../models/commerce';

/**
 * The commerce plane's channel and inbox surface. Every route here is mounted under
 * `/orgs/:orgId/...` and sits behind `requireOrgMember` — there is no un-scoped commerce endpoint.
 */

/**
 * GET /orgs/:orgId/channels — the organization's connected messaging accounts.
 *
 * `signup` carries what the browser needs to launch Meta's Embedded Signup dialog. It is served by
 * the API rather than baked into the bundle so a deploy can be reconfigured without a rebuild, and
 * so the website never has to know a Meta app id that might differ per environment.
 */
export interface ListChannelAccountsResponse {
  readonly accounts: readonly ChannelAccount[];
  readonly signup: EmbeddedSignupConfig | null;
}

/**
 * The public half of the Meta app's identity — safe to hand a browser, since Embedded Signup runs
 * client-side and returns only a short-lived code. The app SECRET never leaves the server.
 * Null when the deploy has the commerce Meta integration switched off.
 */
export interface EmbeddedSignupConfig {
  readonly appId: string;
  /** Meta's Embedded Signup flow configuration id, which pins the permissions being requested. */
  readonly configId: string;
  readonly graphVersion: string;
}

/**
 * POST /orgs/:orgId/channels/whatsapp — complete a WhatsApp connection.
 *
 * The browser runs Meta's Embedded Signup and hands back a one-time `code`. The server does
 * everything else: exchange the code for a business token, read the WABA and phone number,
 * register the number, subscribe this app to the WABA's webhooks, and vault the token. The client
 * never sees a credential, and the ids it reports are re-read from Meta rather than trusted.
 */
export interface CreateChannelAccountRequest {
  readonly code: string;
  /**
   * The number's six-digit two-step verification PIN, required to register it for Cloud API sending.
   *
   * Per CLIENT NUMBER, never per deploy — it belongs to the business connecting, not to Stewra, so it
   * cannot live in configuration without recreating the single-tenant assumption this whole surface
   * exists to remove. It is used once, at registration, and is never stored.
   *
   * Optional because a number Meta already reports as `CONNECTED` needs no registration; the server
   * checks that first and only demands a PIN when the number actually requires one.
   */
  readonly pin?: string;
}

export interface CreateChannelAccountResponse {
  readonly account: ChannelAccount;
}

/**
 * DELETE /orgs/:orgId/channels/:accountId — disconnect. Unsubscribes the app from the WABA's
 * webhooks and deletes the vaulted token, so a disconnect actually severs access rather than only
 * hiding the row. Requires `admin` or above.
 */
export interface DeleteChannelAccountResponse {
  readonly disconnected: boolean;
}

/** GET /orgs/:orgId/conversations — the shared inbox, most recently active first. */
export interface ListCommerceConversationsRequest {
  /** Page size. Server clamps to a sane maximum; omitted means the server default. */
  readonly limit?: number;
  /** Opaque cursor from the previous page's `nextCursor`. */
  readonly cursor?: string;
}

export interface ListCommerceConversationsResponse {
  readonly conversations: readonly CommerceConversationSummary[];
  /** Null when this is the last page. */
  readonly nextCursor: string | null;
}

/** GET /orgs/:orgId/conversations/:conversationId/messages — oldest-first within the page. */
export interface ListCommerceMessagesRequest {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListCommerceMessagesResponse {
  readonly messages: readonly CommerceMessage[];
  readonly nextCursor: string | null;
}

/**
 * POST /orgs/:orgId/conversations/:conversationId/messages — an agent's free-form reply.
 *
 * Valid only inside the 24-hour customer-service window; the server rejects the send with a clear
 * error when the window has closed rather than silently dropping it, because Meta accepts the API
 * call and then never delivers. Business-initiated (template) sends are a separate surface, not
 * this one. Requires `agent` or above.
 */
export interface CreateCommerceMessageRequest {
  readonly body: string;
}

export interface CreateCommerceMessageResponse {
  readonly message: CommerceMessage;
}

/**
 * POST /orgs/:orgId/conversations/:conversationId/template-messages — send one approved template
 * into one conversation.
 *
 * This is the business-initiated half of the inbox: the way to reach a customer after the 24-hour
 * service window has closed (and the only way Meta will deliver anything then). It is valid inside
 * the window too — a template is never LESS deliverable than free text.
 *
 * The consent gate keys off the template's category: a `utility` or `authentication` template asks
 * only that the contact is not suppressed, while a `marketing` template — or one whose category
 * this build does not recognize — requires full marketing consent, exactly as a broadcast would.
 * One-at-a-time is not a loophole.
 *
 * Requires `agent` or above, like a reply: it is one message to one customer who is part of an
 * existing conversation, not a campaign.
 */
export interface SendConversationTemplateRequest {
  readonly templateId: string;
  /** Positional fills. Length must equal the template's `variableCount`, checked before sending. */
  readonly variables: readonly string[];
}

export interface SendConversationTemplateResponse {
  readonly message: CommerceMessage;
}

/**
 * The consent surface — how an organization proves it may message the people on its list.
 *
 * Read routes are open to `viewer` because seeing why a contact cannot be messaged is part of doing
 * the job. Every WRITE here requires `admin` or above: recording consent on someone else's behalf,
 * lifting a block, and signing the attestation are all statements the organization is answerable
 * for, and an `agent` working the inbox is not the person who should be making them.
 */

/** GET /orgs/:orgId/contacts/:contactId/consents — the full history, newest first. */
export interface ListContactConsentsResponse {
  readonly consents: readonly ContactConsent[];
}

/**
 * POST /orgs/:orgId/contacts/:contactId/consents — record consent gathered outside Stewra.
 *
 * `evidence` is required and cannot be blank. A consent record with no proof is indistinguishable
 * from an unchecked box, and it is the one field here that has to survive being read by someone who
 * does not take the organization's word for it.
 */
export interface RecordContactConsentRequest {
  readonly purpose: ConsentPurpose;
  readonly state: ConsentState;
  readonly source: ConsentSource;
  /** How this consent was obtained: a form URL, an ad id, an import file name. */
  readonly evidence: string;
}

export interface RecordContactConsentResponse {
  readonly consent: ContactConsent;
}

/** GET /orgs/:orgId/suppressions — addresses this organization may not message. */
export interface ListSuppressionsRequest {
  readonly limit?: number;
}

export interface ListSuppressionsResponse {
  readonly suppressions: readonly Suppression[];
}

/**
 * POST /orgs/:orgId/suppressions — block an address by hand.
 *
 * Keyed on the platform address rather than a contact id, because that is what the block has to
 * follow: contact rows get deleted and re-imported, and a block attached to the row would lift
 * itself the next time someone uploaded a list.
 */
export interface CreateSuppressionRequest {
  readonly platform: string;
  readonly externalId: string;
  readonly reason: SuppressionReason;
  readonly detail?: string;
}

export interface CreateSuppressionResponse {
  readonly suppression: Suppression;
}

/**
 * DELETE /orgs/:orgId/suppressions/:platform/:externalId — unblock.
 *
 * Lifting a block does NOT record consent. Unblocking an address so support can answer a question
 * and holding permission to market to it are separate facts, and merging them would let a routine
 * operational action manufacture an opt-in.
 */
export interface DeleteSuppressionResponse {
  readonly lifted: boolean;
}

/**
 * GET /orgs/:orgId/messaging-policy — quiet hours and the attestation.
 *
 * `policy` is null for an organization that has never set one, and that is not a gap to paper over:
 * it means no marketing send is permitted yet. The client should read null as "not configured", never
 * as "no restrictions".
 */
export interface GetMessagingPolicyResponse {
  readonly policy: MessagingPolicy | null;
}

/**
 * PUT /orgs/:orgId/messaging-policy — set quiet hours.
 *
 * `timezone` is required with no default. A marketing message that lands at 3am is a complaint, and a
 * guessed zone would produce exactly that while looking configured. Setting quiet hours deliberately
 * does not touch the attestation: changing when you send is an operational edit, and signing a
 * statement about how you obtained consent is not.
 */
export interface UpdateMessagingPolicyRequest {
  /** IANA zone, e.g. `Europe/London`. Rejected at write time if the runtime cannot resolve it. */
  readonly timezone: string;
  /** Local wall-clock `HH:MM` bounds of the window in which marketing sends are NOT permitted. */
  readonly quietHoursStart: string;
  readonly quietHoursEnd: string;
}

export interface UpdateMessagingPolicyResponse {
  readonly policy: MessagingPolicy;
}

/**
 * POST /orgs/:orgId/messaging-policy/attestation — sign the lawful-opt-in statement.
 *
 * The exact sentence the member accepted is stored verbatim, for the same reason `bridge_consents`
 * stores the user's typed words: if the statement is reworded next quarter, this record still proves
 * what THIS organization actually agreed to. Requires an existing policy — an attestation without
 * quiet hours would read as signed while leaving the org half-configured.
 */
export interface AttestMessagingPolicyRequest {
  readonly attestationText: string;
}

export interface AttestMessagingPolicyResponse {
  readonly policy: MessagingPolicy;
}

// --- Audience: contacts, tags, segments -------------------------------------------------------

/**
 * GET /orgs/:orgId/contacts — the organization's people, newest first.
 *
 * `search` matches the display name, the phone number and the platform id. Three columns rather than
 * one because an operator looking for a contact has whichever of the three the customer just quoted
 * at them, and a search that only covers names fails on exactly the call where it is needed.
 */
export interface ListCommerceContactsRequest {
  readonly limit?: number;
  readonly search?: string;
  /** Only contacts carrying this tag, by name, case-insensitively. */
  readonly tag?: string;
}

export interface ListCommerceContactsResponse {
  readonly contacts: readonly CommerceContactWithTags[];
}

/** A contact plus its labels, so the list view needs one request rather than one per row. */
export interface CommerceContactWithTags extends CommerceContact {
  readonly tags: readonly string[];
}

export interface GetCommerceContactResponse {
  readonly contact: CommerceContactWithTags;
}

/**
 * POST /orgs/:orgId/contacts — put a person into the audience without waiting for them to write in.
 *
 * Until this existed the only way a contact came to exist was `commerceInboundService` upserting one
 * when a customer messaged first, which meant a tenant with a perfectly lawful opt-in list had no way
 * to load it and no campaign they could run on day one.
 *
 * `phoneE164` is the only identifier accepted, and it is normalized and range-checked server-side.
 * The platform id is derived from it rather than supplied: it is the address messages are delivered
 * to and the key consent is recorded against, so a client that could assert it directly could point
 * a new contact's history at a stranger's phone.
 *
 * `consent` is OPTIONAL, and that is deliberate in both directions. Omitting it creates a contact
 * that can be seen, tagged and segmented but that marketing cannot reach — `assertMaySend` refuses on
 * a missing consent record, as it does everywhere else, so absence stays the refusing state. Making
 * it mandatory would not produce more consent; it would produce an evidence field with "yes" typed
 * into it, which is worse than an empty one because it looks like proof. When it IS supplied it must
 * carry a real source and real evidence, and it is written through `consentService` — the same
 * versioned, append-only path the inbound keyword handler uses — so no door into the audience can
 * record permission the send gate would not recognize.
 */
export interface CreateCommerceContactRequest {
  /** Any dialable form; normalized to E.164 server-side. Must resolve to a known calling code. */
  readonly phoneE164: string;
  readonly displayName?: string | null;
  readonly attributes?: Readonly<Record<string, string>>;
  /** Label names, created on first use — the same find-or-create as `POST .../tags`. */
  readonly tags?: readonly string[];
  readonly consent?: {
    readonly purpose: ConsentPurpose;
    readonly state: ConsentState;
    readonly source: ConsentSource;
    /** How it was obtained: a form URL, an ad id, a list name. Never empty. */
    readonly evidence: string;
  };
}

export interface CreateCommerceContactResponse {
  readonly contact: CommerceContactWithTags;
  /** The consent row written alongside, or null when the request carried none. */
  readonly consent: ContactConsent | null;
}

/**
 * PATCH /orgs/:orgId/contacts/:contactId — edit what the organization knows about a person.
 *
 * `attributes` MERGES rather than replaces, and a null value deletes that key. Replacing the whole
 * map would mean any client that read the contact before another operator added a field would erase
 * that field on save, silently, with no conflict anywhere to notice. Merge makes the request say what
 * it actually intends to change.
 *
 * The platform id is not editable by anyone. It is the address messages are delivered to and the key
 * consent and suppression are recorded against; changing it would redirect a person's history onto a
 * stranger's phone.
 */
export interface UpdateCommerceContactRequest {
  readonly displayName?: string | null;
  readonly attributes?: Readonly<Record<string, string | null>>;
}

export interface UpdateCommerceContactResponse {
  readonly contact: CommerceContactWithTags;
}

/**
 * POST /orgs/:orgId/contacts/import — upload a list.
 *
 * There is no request INTERFACE for this one, and that is not an omission: the body is
 * `multipart/form-data` carrying the CSV itself, because a fifty-thousand-row file does not belong
 * inside a JSON string and `express.json` is capped at 1mb. The optional `platform` field rides
 * alongside as a form field. The shape that matters is the file's own header, and it is documented
 * here because that is the actual contract:
 *
 *   `phone`             — required. Any dialable form; must carry a country code.
 *   `consent_purpose`   — required. `service` or `marketing`.
 *   `consent_state`     — required. `opted_in` or `opted_out`.
 *   `consent_source`    — required. One of {@link CONSENT_SOURCES}.
 *   `consent_evidence`  — required, non-empty. The form URL, ad id, or list name.
 *   `name`, `tags`      — optional. `tags` is semicolon-separated, since commas belong to the CSV.
 *   anything else       — an attribute, keyed by the column name.
 *
 * **Consent is REQUIRED here, where the single-contact form leaves it optional, and the asymmetry is
 * the point.** A person adding one contact by hand is present and answerable for that one assertion,
 * and a contact with no consent is simply one marketing cannot reach. A file has no such presence:
 * the rows are strangers in bulk, and a bulk list with no provenance is precisely the purchased list
 * the consent regime exists to refuse. So a row that carries none is reported back and NOT imported —
 * never imported-without-consent, which would look like the import working, and never guessed at.
 */
export interface CreateContactImportResponse {
  /** Accepted, queued, and not yet run. Poll {@link GetContactImportResponse} for the outcome. */
  readonly import: ContactImport;
}

export interface ListContactImportsResponse {
  readonly imports: readonly ContactImport[];
}

/**
 * GET /orgs/:orgId/contacts/imports/:importId — the progress, and then the report.
 *
 * `rows` carries the SKIPPED rows only, and it is capped. The imported ones are already visible as
 * contacts, so repeating them here would bury the hundred rows that need attention under the nine
 * hundred that do not. `skippedTruncated` says when the list was cut, so a client never presents a
 * partial report as the whole of it.
 */
export interface GetContactImportResponse {
  readonly import: ContactImport;
  readonly skippedRows: readonly ContactImportRow[];
  readonly skippedTruncated: boolean;
}

/**
 * POST /orgs/:orgId/contacts/:contactId/tags — label a contact, creating the tag if it is new.
 *
 * By NAME rather than by id, because that is how tagging is actually used: someone types "vip" in a
 * box. Requiring the client to create the tag first and then attach it would make every first use of
 * a label a two-request dance that can half-fail.
 */
export interface AddContactTagRequest {
  readonly tag: string;
}

export interface AddContactTagResponse {
  readonly tag: CommerceTag;
}

export interface RemoveContactTagResponse {
  readonly removed: boolean;
}

export interface ListCommerceTagsResponse {
  readonly tags: readonly CommerceTag[];
}

/**
 * DELETE /orgs/:orgId/tags/:tagId — delete a label everywhere it is applied.
 *
 * REFUSED while any segment's rules still mention the tag, with those segments named in the error. A
 * tag rule left pointing at a deleted label turns a campaign's audience to zero — or, with `not_has`,
 * to everyone — and neither failure announces itself at send time.
 */
export interface DeleteCommerceTagResponse {
  readonly deleted: boolean;
}

export interface ListCommerceSegmentsResponse {
  readonly segments: readonly CommerceSegment[];
}

export interface CreateCommerceSegmentRequest {
  readonly name: string;
  readonly description?: string | null;
  readonly definition: SegmentDefinition;
}

export interface CreateCommerceSegmentResponse {
  readonly segment: CommerceSegment;
}

export interface GetCommerceSegmentResponse {
  readonly segment: CommerceSegment;
}

/** PUT /orgs/:orgId/segments/:segmentId — a whole-object replace; the definition is the object. */
export interface UpdateCommerceSegmentRequest {
  readonly name: string;
  readonly description?: string | null;
  readonly definition: SegmentDefinition;
}

export interface UpdateCommerceSegmentResponse {
  readonly segment: CommerceSegment;
}

export interface DeleteCommerceSegmentResponse {
  readonly deleted: boolean;
}

/**
 * POST /orgs/:orgId/segments/preview — what an UNSAVED definition would reach.
 *
 * Takes the definition in the body rather than a saved id, deliberately: the question "how many
 * people is this rule?" is asked while the rule is still being written, and a preview that required
 * saving first would make every experiment a permanent object someone has to clean up later.
 */
export interface PreviewSegmentRequest {
  readonly definition: SegmentDefinition;
  /** How many members to return alongside the counts. The counts always cover the whole audience. */
  readonly sampleLimit?: number;
}

export interface PreviewSegmentResponse {
  readonly preview: AudiencePreview;
}

/** GET /orgs/:orgId/segments/:segmentId/members — the saved segment's audience, page by page. */
export interface ListSegmentMembersRequest {
  readonly limit?: number;
  readonly offset?: number;
  /** When true, drop the members marketing cannot reach — the list a broadcast would actually use. */
  readonly sendableOnly?: boolean;
}

export interface ListSegmentMembersResponse {
  readonly members: readonly AudienceMember[];
}

// --- Templates ---------------------------------------------------------------------------------

/**
 * GET /orgs/:orgId/templates — the approved message shapes this organization can broadcast with.
 *
 * Read from Stewra's mirror rather than from Meta on every request, because the page is opened far
 * more often than templates change and Meta rate-limits reads per WABA. Each row carries its own
 * `lastSyncedAt`, so the UI can say "last checked 3 days ago" instead of implying every status is
 * live — the mirror is never presented as the authority.
 */
export interface ListMessageTemplatesRequest {
  readonly channelAccountId?: string;
}

export interface ListMessageTemplatesResponse {
  readonly templates: readonly MessageTemplate[];
}

/**
 * POST /orgs/:orgId/templates — submit a new template to Meta for approval.
 *
 * Creation is a REQUEST, not a fact: the response comes back `pending` and Meta decides, usually
 * within minutes but with no guarantee. Nothing can be sent from it until it is `approved`, and the
 * client is told that in those words rather than being left to infer it from a status enum.
 *
 * The body is plain text with `{{1}}`-style positional placeholders, numbered from 1 with no gaps.
 * Meta rejects gaps, and it rejects a body that begins or ends with a placeholder; both are checked
 * here first so the client gets a specific message instead of Meta's.
 */
export interface CreateMessageTemplateRequest {
  readonly channelAccountId: string;
  /** Lowercase letters, digits and underscores — Meta's own rule, enforced before submission. */
  readonly name: string;
  readonly language: string;
  readonly category: TemplateCategory;
  readonly headerText?: string | null;
  readonly bodyText: string;
  readonly footerText?: string | null;
}

export interface CreateMessageTemplateResponse {
  readonly template: MessageTemplate;
}

/**
 * POST /orgs/:orgId/templates/sync — pull every template's current state from Meta.
 *
 * On demand as well as on a schedule, because the schedule is hourly and an operator who has just
 * been told by Meta that their template is approved should not have to wait for it. Returns what
 * changed rather than only a count: "3 synced" and "1 of your templates was paused by Meta" are
 * different sentences, and the second is the one that matters.
 */
export interface SyncMessageTemplatesRequest {
  /**
   * Which connected account to re-read. Required rather than "all of them": templates belong to a
   * WABA, Meta rate-limits per WABA, and an operator pressing Refresh on one account's page should
   * not spend another account's budget.
   */
  readonly channelAccountId: string;
}

export interface SyncMessageTemplatesResponse {
  readonly synced: number;
  /** Templates whose status is different from what was stored before this sync. */
  readonly changed: readonly MessageTemplate[];
}

/**
 * DELETE /orgs/:orgId/templates/:templateId — delete at Meta, then here.
 *
 * REFUSED while a scheduled broadcast still points at it, naming those broadcasts. A campaign whose
 * template vanished fails at send time, per recipient, having already reached some of them.
 */
export interface DeleteMessageTemplateResponse {
  readonly deleted: boolean;
}

// --- Broadcasts --------------------------------------------------------------------------------

/** GET /orgs/:orgId/broadcasts — newest first. */
export interface ListBroadcastsResponse {
  readonly broadcasts: readonly CommerceBroadcast[];
}

/**
 * POST /orgs/:orgId/broadcasts — schedule a template send to a segment.
 *
 * `scheduledFor` is required and has no default. "Send now" is expressible — a timestamp in the past
 * or present dispatches on the next worker pass — but it has to be SAID. A missing schedule
 * defaulting to now is the one mistake in this endpoint that cannot be undone, because by the time
 * anybody notices, the messages have arrived.
 *
 * Requires `admin`. A broadcast spends the client's money and their phone number's reputation.
 */
export interface CreateBroadcastRequest {
  readonly name: string;
  readonly channelAccountId: string;
  readonly segmentId: string;
  readonly templateId: string;
  /** Positional fills. Length must equal the template's `variableCount`, checked before scheduling. */
  readonly variables: readonly string[];
  readonly scheduledFor: string;
}

export interface CreateBroadcastResponse {
  readonly broadcast: CommerceBroadcast;
}

export interface GetBroadcastResponse {
  readonly broadcast: CommerceBroadcast;
}

/**
 * POST /orgs/:orgId/broadcasts/preview — what this broadcast would reach and cost, before scheduling.
 *
 * Takes the same fields as the create call so the answer describes the campaign about to be
 * scheduled, not an approximation of it. The audience is resolved live; the forecast counts billable
 * messages per country but names no price — see {@link BroadcastCostForecast} for why inventing one
 * would be worse than omitting it.
 */
export interface PreviewBroadcastRequest {
  readonly segmentId: string;
  readonly templateId: string;
}

export interface PreviewBroadcastResponse {
  readonly audience: AudiencePreview;
  readonly forecast: BroadcastCostForecast;
}

/**
 * POST /orgs/:orgId/broadcasts/:broadcastId/cancel — stop it.
 *
 * A `scheduled` broadcast is cancelled outright. A `running` one stops at the next batch: the people
 * already messaged stay messaged, and the response says how many that was. Nothing here can unsend.
 */
export interface CancelBroadcastResponse {
  readonly broadcast: CommerceBroadcast;
}

/** POST /orgs/:orgId/broadcasts/:broadcastId/resume — put a paused broadcast back on the queue. */
export interface ResumeBroadcastResponse {
  readonly broadcast: CommerceBroadcast;
}

/**
 * GET /orgs/:orgId/broadcasts/:broadcastId/recipients — who it reached, and who it did not.
 *
 * Filterable by status because the interesting page is almost never "everyone": after a campaign the
 * question is which 40 failed and why.
 */
export interface ListBroadcastRecipientsRequest {
  readonly status?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface ListBroadcastRecipientsResponse {
  readonly recipients: readonly BroadcastRecipient[];
}

// --- Cost and queue ----------------------------------------------------------------------------

/**
 * GET /orgs/:orgId/costs — what Meta charged this organization, by category, over a period.
 *
 * The billing input. Stewra takes no margin on messages — the client pays Meta's cost plus a flat
 * platform fee — so this is not a revenue report, it is the pass-through line on their invoice, and
 * it has to be reconstructable from Meta's own reporting.
 */
export interface GetCommerceCostsRequest {
  /** ISO timestamps. Both required: a period with a guessed boundary is a bill with a guessed total. */
  readonly from: string;
  readonly to: string;
}

export interface GetCommerceCostsResponse {
  readonly summary: CommerceCostSummary;
  /**
   * Real money, ADDED BESIDE the counts (migration 051) — `summary` still refuses to invent a
   * number, and anything unpriced or unrated shows up here as `complete: false` rather than as a
   * smaller total. Note the two halves cut time differently on purpose: `summary` counts by when
   * messages were CREATED, `money` sums by when they were PRICED, because a receipt landing three
   * days into the next month must bill in the period it was priced to keep closed invoices
   * immutable.
   */
  readonly money: CommerceMoneySummary;
}

/**
 * GET /orgs/:orgId/jobs — the organization's background work.
 *
 * Exposed because a broadcast IS a queue of jobs, and "nothing has happened yet" and "it failed
 * eleven minutes ago" look identical from the campaign screen without it.
 */
export interface ListCommerceJobsRequest {
  readonly status?: CommerceJobStatus;
  readonly limit?: number;
}

export interface ListCommerceJobsResponse {
  readonly jobs: readonly CommerceJob[];
  /** Every status present even at zero — the number a queue-depth check reads. */
  readonly counts: Readonly<Record<CommerceJobStatus, number>>;
}

/**
 * POST /orgs/:orgId/optin-links — mint a click-to-WhatsApp link that collects consent.
 *
 * There is deliberately no update request. The link's sentence is what customers agreed to, and it
 * is printed on things we cannot recall — a menu, a poster, a QR sticker on a box. Editing it would
 * retroactively change the meaning of every opt-in already gathered under it, so the only two verbs
 * are create and disable.
 */
export interface CreateOptinLinkRequest {
  /** Which connected number the link opens a chat with. */
  readonly channelAccountId: string;
  /** The operator's label for it. Unique within the organization. */
  readonly name: string;
  readonly purpose: ConsentPurpose;
  /**
   * The sentence the customer sends, in their words — "Yes, send me offers and updates".
   *
   * The server appends the token; the caller must not, and cannot usefully try. The phrase should
   * read as an agreement rather than a greeting, because it IS the evidence: "hi" arriving through a
   * marketing link proves nothing about what the sender meant.
   */
  readonly phrase: string;
}

export interface CreateOptinLinkResponse {
  readonly link: OptinLink;
}

export interface ListOptinLinksResponse {
  readonly links: readonly OptinLink[];
}

/** POST /orgs/:orgId/optin-links/:linkId/disable — stop honouring it, keep the consents it gathered. */
export interface DisableOptinLinkResponse {
  readonly link: OptinLink;
}

/**
 * The platform-operator rate-card surface — `/platform/rate-cards`, NOT under `/orgs/:orgId`.
 *
 * The one deliberate exception to the comment at the top of this file: these routes sit behind the
 * install-admin gate rather than `requireOrgMember`, because they set the prices organizations are
 * billed at, and a client must never edit the price they pay. No org role, including owner, grants
 * any access here.
 */

/** POST /platform/rate-cards — load one transcription of Meta's price sheet for one currency. */
export interface LoadRateCardRequest {
  /** ISO 4217, uppercase — the WABA billing currency this card prices. */
  readonly currency: string;
  /** ISO timestamp the prices take effect; must be strictly after the live card's, if one exists. */
  readonly effectiveFrom: string;
  /** Which Meta document was transcribed (URL or filename plus its published date). Required. */
  readonly sourceNote: string;
  readonly rates: readonly LoadRateCardRate[];
}

export interface LoadRateCardRate {
  readonly countryCallingCode: string;
  readonly pricingCategory: MessagePricingCategory;
  /** Micros as a decimal string — the value is a bigint and JSON numbers round above 2^53. */
  readonly amountMicros: string;
  readonly unit: RateUnit;
}

export interface LoadRateCardResponse {
  readonly card: CommerceRateCard;
}

/** GET /platform/rate-cards — every card ever loaded, including closed eras. */
export interface ListRateCardsResponse {
  readonly cards: readonly CommerceRateCard[];
}

/** GET /platform/rate-cards/:cardId — one card and its full price list. */
export interface GetRateCardResponse {
  readonly card: CommerceRateCard;
  readonly rates: readonly CommerceMessageRate[];
}

/**
 * PUT /platform/spend-caps — grant or change one org's monthly allowance for one currency.
 * Install-admin only, same argument as the rate cards: a client must never raise their own spend
 * limit before paying. A PUT because the (org, currency) slot holds exactly one cap; setting it
 * again replaces the limit and records the change in the spend ledger.
 */
export interface SetSpendCapRequest {
  readonly orgId: string;
  /** ISO 4217, uppercase — must match the WABA billing currency reservations are priced in. */
  readonly currency: string;
  /** The new monthly allowance, micros as a decimal string. "0" is a deliberate lockout. */
  readonly limitMicros: string;
  /** Why — "paid invoice #12", "pilot agreement". Required; an unexplained limit defends nothing. */
  readonly note: string;
}

export interface SetSpendCapResponse {
  readonly cap: CommerceSpendCap;
}

/** GET /platform/spend-caps?orgId= — an org's caps with the current month's usage beside each. */
export interface ListSpendCapsResponse {
  readonly caps: readonly CommerceSpendCap[];
  readonly usage: readonly CommerceSpendUsage[];
}

/**
 * GET /orgs/:orgId/spend — the org-facing, read-only view: what headroom exists this month and how
 * much of it is held or spent. Readable by members because a paused campaign needs an explanation;
 * writable by nobody on this surface.
 */
export interface GetOrgSpendResponse {
  readonly usage: readonly CommerceSpendUsage[];
}

/**
 * PUT /platform/billing/plans — create a plan, or append a new version to an existing one (matched
 * by name). Install-admin only. A PUT because the name is the identity and the call is "make the
 * catalog say this"; the versions underneath are append-only, so no earlier subscriber's price
 * moves.
 */
export interface UpsertPlanRequest {
  readonly name: string;
  /** The flat monthly platform fee, micros as a decimal string. "0" is a legal fee. */
  readonly platformFeeMicros: string;
  /** ISO 4217, uppercase — the currency the fee is invoiced in. */
  readonly currency: string;
  /** Why this version exists — the agreement or decision it transcribes. Required. */
  readonly note: string;
}

export interface UpsertPlanResponse {
  readonly plan: CommercePlan;
  readonly version: CommercePlanVersion;
}

/** GET /platform/billing/plans — the whole catalog, every version of every plan. */
export interface ListPlansResponse {
  readonly plans: readonly {
    readonly plan: CommercePlan;
    readonly versions: readonly CommercePlanVersion[];
  }[];
}

/**
 * PUT /platform/billing/subscriptions — put an org on a plan (its LATEST version, frozen from that
 * moment), or take it off every plan with `planId: null`. Install-admin only: a subscription is
 * what decides the platform-fee line on the org's invoices.
 */
export interface SetSubscriptionRequest {
  readonly orgId: string;
  /** The plan to subscribe to, or null to end the current subscription. */
  readonly planId: string | null;
  /** Why — "signed order form 2026-08", "churned". Required. */
  readonly note: string;
}

export interface SetSubscriptionResponse {
  readonly subscription: CommerceSubscriptionView | null;
}

/** GET /orgs/:orgId/billing — the org's own view of what plan it is on, if any. */
export interface GetOrgBillingResponse {
  readonly subscription: CommerceSubscriptionView | null;
}

/** GET /orgs/:orgId/invoices — newest period first, every status. */
export interface ListInvoicesResponse {
  readonly invoices: readonly CommerceInvoice[];
}

/** GET /orgs/:orgId/invoices/:invoiceId — one invoice and its lines. */
export interface GetInvoiceResponse {
  readonly invoice: CommerceInvoice;
  readonly lines: readonly CommerceInvoiceLine[];
}
