import type { Selectable } from 'kysely';
import { sql } from 'kysely';
import type {
  CommerceConversationSummary,
  CommerceMessage,
  CommerceMessageStatus,
  CommercePlatform,
  MessagePricingCategory,
} from '@stewra/shared-types';
import { db } from '../../database/index.js';
import type { CommerceMessagesTable } from '../../database/types.js';

/** How long an inbound message keeps free-form replies legal. Meta's rule, not a tunable of ours. */
const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Longest preview the inbox list carries, so listing never ships whole message bodies. */
const PREVIEW_CHARS = 160;

/**
 * How far along the delivery path each status is.
 *
 * Meta sends `sent`, `delivered` and `read` as three separate receipts and guarantees nothing about
 * the order they arrive in — a retried `sent` landing after a `read` is ordinary traffic. Ranking
 * them means a late receipt cannot walk a message backwards and tell an operator a message they
 * watched being read is merely sent. `failed` is outside the ordering entirely and handled
 * separately: it is not a stage, it is an outcome, and it wins from wherever it arrives.
 */
const DELIVERY_RANK: Record<CommerceMessageStatus, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  failed: 0,
};

/** The same ranking, as SQL over the stored value, so the comparison happens inside the UPDATE. */
const CURRENT_RANK = sql<number>`case commerce_messages.status
  when 'queued' then 0
  when 'sent' then 1
  when 'delivered' then 2
  when 'read' then 3
  else 0
end`;

export function toMessage(row: Selectable<CommerceMessagesTable>): CommerceMessage {
  return {
    id: row.id,
    orgId: row.org_id,
    conversationId: row.conversation_id,
    direction: row.direction,
    platform: row.platform,
    providerMessageId: row.provider_message_id,
    body: row.body,
    status: row.status,
    failureReason: row.failure_reason,
    sentByUserId: row.sent_by_user_id,
    templateId: row.template_id,
    cost: {
      pricingCategory: row.pricing_category,
      providerCategory: row.provider_pricing_category,
      pricingModel: row.pricing_model,
      billable: row.billable,
      providerConversationId: row.provider_conversation_id,
    },
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * The commerce inbox: contacts, threads and messages, all scoped by `org_id`.
 *
 * Every read here takes an `orgId` that `requireOrgMember` has already verified, and filters on it —
 * including the message reads, which could have joined through the conversation instead. They do not,
 * on purpose: `commerce_messages.org_id` is denormalized precisely so a tenant filter is never one
 * join away from being forgotten.
 */
class CommerceInboxRepository {
  /**
   * Claim a provider message id, returning false if it has been seen before.
   *
   * The unique index on `(platform, provider_message_id)` IS the lock — an insert that violates it
   * means another delivery of the same message already won. Meta retries for up to seven days until
   * it sees a 200, so redelivery is guaranteed rather than hypothetical, and a check-then-insert
   * would race with itself under exactly that retry.
   */
  async claimInbound(platform: CommercePlatform, providerMessageId: string): Promise<boolean> {
    const inserted = await db
      .insertInto('commerce_inbound_messages')
      .values({ platform, provider_message_id: providerMessageId })
      .onConflict((oc) => oc.columns(['platform', 'provider_message_id']).doNothing())
      .returning('id')
      .executeTakeFirst();
    return inserted !== undefined;
  }

  /** Find-or-create the contact, keeping the platform-reported display name fresh. */
  async upsertContact(params: {
    orgId: string;
    platform: CommercePlatform;
    externalId: string;
    displayName: string | null;
    phoneE164: string | null;
  }): Promise<string> {
    const row = await db
      .insertInto('commerce_contacts')
      .values({
        org_id: params.orgId,
        platform: params.platform,
        external_id: params.externalId,
        display_name: params.displayName,
        phone_e164: params.phoneE164,
      })
      .onConflict((oc) =>
        oc.columns(['org_id', 'platform', 'external_id']).doUpdateSet((eb) => ({
          // Only overwrite with a name the platform actually reported — a later payload that omits
          // the profile must not blank out a name we already have.
          display_name: eb.fn.coalesce(
            eb.ref('excluded.display_name'),
            eb.ref('commerce_contacts.display_name'),
          ),
          phone_e164: eb.fn.coalesce(
            eb.ref('excluded.phone_e164'),
            eb.ref('commerce_contacts.phone_e164'),
          ),
        })),
      )
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** Find-or-create the thread between one connected account and one contact. */
  async upsertConversation(params: {
    orgId: string;
    channelAccountId: string;
    contactId: string;
    platform: CommercePlatform;
  }): Promise<string> {
    const row = await db
      .insertInto('commerce_conversations')
      .values({
        org_id: params.orgId,
        channel_account_id: params.channelAccountId,
        contact_id: params.contactId,
        platform: params.platform,
      })
      .onConflict((oc) =>
        // Nothing to change on conflict, but the row's id still has to come back, so DO UPDATE with a
        // no-op assignment rather than DO NOTHING — which returns no row at all.
        oc
          .columns(['channel_account_id', 'contact_id'])
          .doUpdateSet((eb) => ({ platform: eb.ref('excluded.platform') })),
      )
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /**
   * Record an inbound message and reopen the 24-hour service window it just started.
   *
   * The window is stamped from the message's own timestamp, not from `now()`: a webhook that arrives
   * late (Meta's retries can be hours behind) would otherwise grant the business more free-form time
   * than Meta will actually honour, and the inbox would tell an agent their reply will send when it
   * will not.
   */
  async recordInbound(params: {
    orgId: string;
    conversationId: string;
    platform: CommercePlatform;
    providerMessageId: string;
    body: string;
    sentAt: Date;
  }): Promise<CommerceMessage> {
    return db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto('commerce_messages')
        .values({
          org_id: params.orgId,
          conversation_id: params.conversationId,
          direction: 'inbound',
          platform: params.platform,
          provider_message_id: params.providerMessageId,
          body: params.body,
          status: 'delivered',
          created_at: params.sentAt,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      await trx
        .updateTable('commerce_conversations')
        .set({
          last_message_at: params.sentAt,
          service_window_expires_at: new Date(params.sentAt.getTime() + SERVICE_WINDOW_MS),
        })
        .where('id', '=', params.conversationId)
        .execute();

      return toMessage(row);
    });
  }

  /**
   * Record an outbound message. Created `queued`; the send result moves it on.
   *
   * `templateId` is set for a business-initiated send and null for a free-form reply. It is what
   * later joins a charge back to the campaign that caused it — Meta reports what it billed, and the
   * template is how that number becomes "this campaign cost this much".
   */
  async recordOutbound(params: {
    orgId: string;
    conversationId: string;
    platform: CommercePlatform;
    body: string;
    sentByUserId: string | null;
    templateId?: string | null;
  }): Promise<CommerceMessage> {
    const row = await db
      .insertInto('commerce_messages')
      .values({
        org_id: params.orgId,
        conversation_id: params.conversationId,
        direction: 'outbound',
        platform: params.platform,
        body: params.body,
        status: 'queued',
        sent_by_user_id: params.sentByUserId,
        template_id: params.templateId ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toMessage(row);
  }

  /**
   * Move a queued outbound message to its outcome.
   *
   * `failureReason` is required on a failure for the same reason `channel_accounts.error_detail` is:
   * a message that is simply `failed` tells an agent nothing they can act on.
   */
  async settleOutbound(params: {
    orgId: string;
    messageId: string;
    status: Extract<CommerceMessageStatus, 'sent' | 'failed'>;
    providerMessageId?: string;
    failureReason?: string;
  }): Promise<CommerceMessage> {
    const row = await db
      .updateTable('commerce_messages')
      .set({
        status: params.status,
        provider_message_id: params.providerMessageId ?? null,
        failure_reason: params.failureReason ?? null,
      })
      .where('org_id', '=', params.orgId)
      .where('id', '=', params.messageId)
      .returningAll()
      .executeTakeFirstOrThrow();

    if (params.status === 'sent') {
      await db
        .updateTable('commerce_conversations')
        .set({ last_message_at: row.created_at })
        .where('id', '=', row.conversation_id)
        .execute();
    }
    return toMessage(row);
  }

  /**
   * Apply a delivery receipt from the platform, including what it says the message cost.
   *
   * Matched on `provider_message_id` within one organization. The org is resolved by the caller from
   * the WABA id in the webhook envelope, exactly as inbound routing is — a status update that
   * matched on the provider id alone would let one tenant's receipt settle another tenant's message
   * if Meta ever reused an id.
   *
   * Two rules here, both about not overwriting a better answer with a worse one:
   *
   *  1. **Status never goes backwards.** Meta sends `sent`, `delivered` and `read` as separate
   *     receipts and does not guarantee their order; a late `sent` arriving after `read` must not
   *     un-read the message. `failed` is the exception and always wins, because a failure reported
   *     at any point is the outcome that actually happened.
   *  2. **Pricing is written only when the webhook carries it.** Most receipts have no `pricing`
   *     block at all. COALESCE keeps whatever a previous receipt established rather than blanking
   *     it, which would turn a priced message back into an unpriced one and lose it from the bill.
   *
   * Returns false when no message matched — a receipt for something we never sent, which is a real
   * possibility (another tool sending on the same number) and is logged rather than treated as an
   * error.
   */
  async applyDeliveryStatus(params: {
    orgId: string;
    providerMessageId: string;
    status: CommerceMessageStatus | null;
    failureReason: string | null;
    pricingCategory: MessagePricingCategory | null;
    providerCategory: string | null;
    pricingModel: string | null;
    billable: boolean | null;
    providerConversationId: string | null;
  }): Promise<boolean> {
    const result = await db
      .updateTable('commerce_messages')
      .set((eb) => ({
        // `sent` < `delivered` < `read`, with `failed` overriding everything. Expressed in SQL rather
        // than read-then-write so two receipts arriving at once cannot both read the old value.
        status:
          params.status === null
            ? eb.ref('commerce_messages.status')
            : sql<CommerceMessageStatus>`case
                when commerce_messages.status = 'failed' then commerce_messages.status
                when ${params.status} = 'failed' then ${params.status}
                when ${DELIVERY_RANK[params.status]} > ${CURRENT_RANK} then ${params.status}
                else commerce_messages.status
              end`,
        failure_reason:
          params.failureReason === null
            ? eb.ref('commerce_messages.failure_reason')
            : params.failureReason,
        pricing_category: eb.fn.coalesce(
          sql<MessagePricingCategory | null>`${params.pricingCategory}::varchar`,
          eb.ref('commerce_messages.pricing_category'),
        ),
        provider_pricing_category: eb.fn.coalesce(
          sql<string | null>`${params.providerCategory}::varchar`,
          eb.ref('commerce_messages.provider_pricing_category'),
        ),
        pricing_model: eb.fn.coalesce(
          sql<string | null>`${params.pricingModel}::varchar`,
          eb.ref('commerce_messages.pricing_model'),
        ),
        billable: eb.fn.coalesce(
          sql<boolean | null>`${params.billable}::boolean`,
          eb.ref('commerce_messages.billable'),
        ),
        provider_conversation_id: eb.fn.coalesce(
          sql<string | null>`${params.providerConversationId}::varchar`,
          eb.ref('commerce_messages.provider_conversation_id'),
        ),
      }))
      .where('org_id', '=', params.orgId)
      .where('provider_message_id', '=', params.providerMessageId)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  /**
   * What Meta charged this org over a period, counted the way the invoice splits it.
   *
   * Everything is read from what the delivery webhooks recorded — never derived from template
   * categories, for the reason on `applyDeliveryStatus`. Four buckets, and the boundaries matter:
   *
   *  - `billableByCategory` — Meta said billable, under a category we model.
   *  - `billableUncategorized` — Meta said billable, under a word we cannot map. Counted apart
   *    because folding it into any named category misstates that category's volume.
   *  - `freeMessages` — Meta explicitly said not billable.
   *  - `unpricedMessages` — the message went out but no pricing has arrived. The discrepancy line:
   *    Meta will bill these and this summary cannot yet, which someone closing a period must see.
   */
  async costSummary(params: {
    orgId: string;
    from: Date;
    to: Date;
  }): Promise<{
    billableByCategory: Record<MessagePricingCategory, number>;
    billableUncategorized: number;
    freeMessages: number;
    unpricedMessages: number;
  }> {
    const rows = await db
      .selectFrom('commerce_messages')
      .select(['billable', 'pricing_category', 'status'])
      .select(db.fn.countAll<string>().as('count'))
      .where('org_id', '=', params.orgId)
      .where('direction', '=', 'outbound')
      .where('created_at', '>=', params.from)
      .where('created_at', '<', params.to)
      .groupBy(['billable', 'pricing_category', 'status'])
      .execute();

    // Every category present at zero, as everywhere: a biller reading absence as none under-reports.
    const billableByCategory: Record<MessagePricingCategory, number> = {
      marketing: 0,
      utility: 0,
      authentication: 0,
      service: 0,
      referral_conversion: 0,
    };
    let billableUncategorized = 0;
    let freeMessages = 0;
    let unpricedMessages = 0;

    for (const row of rows) {
      const count = Number(row.count);
      if (row.billable === true) {
        if (row.pricing_category === null) {
          billableUncategorized += count;
        } else {
          billableByCategory[row.pricing_category] += count;
        }
      } else if (row.billable === false) {
        freeMessages += count;
      } else if (row.status === 'sent' || row.status === 'delivered' || row.status === 'read') {
        // billable is null: no pricing webhook yet. Only messages that actually went out count —
        // a queued or failed message is not awaiting a receipt, it never earned one.
        unpricedMessages += count;
      }
    }

    return { billableByCategory, billableUncategorized, freeMessages, unpricedMessages };
  }

  /** The inbox list: most recently active first, with the contact fields the list view needs. */
  async listConversations(params: {
    orgId: string;
    limit: number;
    before: Date | undefined;
  }): Promise<CommerceConversationSummary[]> {
    let query = db
      .selectFrom('commerce_conversations as c')
      .innerJoin('commerce_contacts as ct', 'ct.id', 'c.contact_id')
      .select([
        'c.id as id',
        'c.org_id as org_id',
        'c.channel_account_id as channel_account_id',
        'c.contact_id as contact_id',
        'c.platform as platform',
        'c.last_message_at as last_message_at',
        'c.service_window_expires_at as service_window_expires_at',
        'c.created_at as created_at',
        'ct.display_name as contact_display_name',
        'ct.phone_e164 as contact_phone_e164',
      ])
      .select((eb) =>
        eb
          .selectFrom('commerce_messages as m')
          .select('m.body')
          .whereRef('m.conversation_id', '=', 'c.id')
          .orderBy('m.created_at', 'desc')
          .limit(1)
          .as('last_message_preview'),
      )
      .where('c.org_id', '=', params.orgId)
      .orderBy('c.last_message_at', 'desc')
      .limit(params.limit);

    if (params.before !== undefined) {
      query = query.where('c.last_message_at', '<', params.before);
    }

    const rows = await query.execute();
    const summaries: CommerceConversationSummary[] = [];
    for (const row of rows) {
      summaries.push({
        id: row.id,
        orgId: row.org_id,
        channelAccountId: row.channel_account_id,
        contactId: row.contact_id,
        platform: row.platform,
        lastMessageAt: row.last_message_at?.toISOString() ?? null,
        serviceWindowExpiresAt: row.service_window_expires_at?.toISOString() ?? null,
        createdAt: row.created_at.toISOString(),
        contactDisplayName: row.contact_display_name,
        contactPhoneE164: row.contact_phone_e164,
        // Cut to one line here rather than in the client, so the list endpoint never ships a whole
        // message body just to render a row.
        lastMessagePreview:
          (row.last_message_preview ?? '').split('\n')[0]?.slice(0, PREVIEW_CHARS) ?? '',
      });
    }
    return summaries;
  }

  /** A thread's messages, newest-first for paging; the controller reverses to render oldest-first. */
  async listMessages(params: {
    orgId: string;
    conversationId: string;
    limit: number;
    before: Date | undefined;
  }): Promise<CommerceMessage[]> {
    let query = db
      .selectFrom('commerce_messages')
      .selectAll()
      .where('org_id', '=', params.orgId)
      .where('conversation_id', '=', params.conversationId)
      .orderBy('created_at', 'desc')
      .limit(params.limit);

    if (params.before !== undefined) {
      query = query.where('created_at', '<', params.before);
    }

    const rows = await query.execute();
    return rows.map(toMessage);
  }

  /** A conversation, only if it belongs to this org. Null otherwise — the caller renders that a 404. */
  async findConversation(
    orgId: string,
    conversationId: string,
  ): Promise<{
    id: string;
    channelAccountId: string;
    contactId: string;
    platform: CommercePlatform;
    serviceWindowExpiresAt: Date | null;
  } | null> {
    const row = await db
      .selectFrom('commerce_conversations')
      .select(['id', 'channel_account_id', 'contact_id', 'platform', 'service_window_expires_at'])
      .where('org_id', '=', orgId)
      .where('id', '=', conversationId)
      .executeTakeFirst();
    if (row === undefined) return null;
    return {
      id: row.id,
      channelAccountId: row.channel_account_id,
      contactId: row.contact_id,
      platform: row.platform,
      serviceWindowExpiresAt: row.service_window_expires_at,
    };
  }

  /** The platform-side id to address a reply to (Meta's `wa_id`), for a conversation's contact. */
  async findContactExternalId(orgId: string, contactId: string): Promise<string | null> {
    const row = await db
      .selectFrom('commerce_contacts')
      .select('external_id')
      .where('org_id', '=', orgId)
      .where('id', '=', contactId)
      .executeTakeFirst();
    return row?.external_id ?? null;
  }
}

export const commerceInboxRepository = new CommerceInboxRepository();
