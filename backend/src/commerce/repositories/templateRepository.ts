import type { Selectable } from 'kysely';
import type { MessageTemplate, TemplateCategory, TemplateStatus } from '@stewra/shared-types';
import { db } from '../../database/index.js';
import type { CommerceTemplatesTable } from '../../database/types.js';

type TemplateRow = Selectable<CommerceTemplatesTable>;

export function toTemplate(row: TemplateRow): MessageTemplate {
  return {
    id: row.id,
    orgId: row.org_id,
    channelAccountId: row.channel_account_id,
    name: row.name,
    language: row.language,
    category: row.category,
    providerCategory: row.provider_category,
    status: row.status,
    providerStatus: row.provider_status,
    providerTemplateId: row.provider_template_id,
    headerText: row.header_text,
    bodyText: row.body_text,
    footerText: row.footer_text,
    variableCount: row.variable_count,
    rejectionReason: row.rejection_reason,
    qualityScore: row.quality_score,
    lastSyncedAt: row.last_synced_at === null ? null : row.last_synced_at.toISOString(),
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * The template mirror's data access.
 *
 * Every write that comes from Meta goes through {@link TemplateRepository.upsertFromMeta}, which is
 * an upsert on `(channel_account_id, name, language)` — Meta's own identity for a template. That
 * matters more than it looks: a client who creates a template in WhatsApp Manager rather than in
 * Stewra has one that exists at Meta and not here, and a sync that could only UPDATE would skip it
 * forever, leaving an approved template invisible to the broadcast screen.
 */
class TemplateRepository {
  async listForOrg(orgId: string, channelAccountId?: string): Promise<MessageTemplate[]> {
    let query = db
      .selectFrom('commerce_templates')
      .selectAll()
      .where('org_id', '=', orgId)
      .orderBy('name', 'asc')
      .orderBy('language', 'asc');
    if (channelAccountId !== undefined) {
      query = query.where('channel_account_id', '=', channelAccountId);
    }
    const rows = await query.execute();
    return rows.map(toTemplate);
  }

  async findById(orgId: string, templateId: string): Promise<MessageTemplate | null> {
    const row = await db
      .selectFrom('commerce_templates')
      .selectAll()
      .where('org_id', '=', orgId)
      .where('id', '=', templateId)
      .executeTakeFirst();
    return row === undefined ? null : toTemplate(row);
  }

  /** Every template under one connected account — what a sync compares Meta's answer against. */
  async listForAccount(channelAccountId: string): Promise<MessageTemplate[]> {
    const rows = await db
      .selectFrom('commerce_templates')
      .selectAll()
      .where('channel_account_id', '=', channelAccountId)
      .execute();
    return rows.map(toTemplate);
  }

  async create(params: {
    orgId: string;
    channelAccountId: string;
    name: string;
    language: string;
    category: TemplateCategory | null;
    providerCategory: string | null;
    status: TemplateStatus;
    providerStatus: string;
    providerTemplateId: string | null;
    headerText: string | null;
    bodyText: string;
    footerText: string | null;
    variableCount: number;
    createdByUserId: string;
  }): Promise<MessageTemplate> {
    const row = await db
      .insertInto('commerce_templates')
      .values({
        org_id: params.orgId,
        channel_account_id: params.channelAccountId,
        name: params.name,
        language: params.language,
        category: params.category,
        provider_category: params.providerCategory,
        status: params.status,
        provider_status: params.providerStatus,
        provider_template_id: params.providerTemplateId,
        header_text: params.headerText,
        body_text: params.bodyText,
        footer_text: params.footerText,
        variable_count: params.variableCount,
        // Meta answered this call, so the mirror is current as of right now. Leaving it null would
        // make a template created seconds ago read as "never confirmed".
        last_synced_at: new Date(),
        created_by_user_id: params.createdByUserId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toTemplate(row);
  }

  /**
   * Write what Meta currently says about a template, creating the row if this build has never seen it.
   *
   * `created_by_user_id` is deliberately absent from the update branch: a template first created in
   * WhatsApp Manager and later synced has no Stewra author, and a sync must never rewrite the author
   * of one that does.
   */
  async upsertFromMeta(params: {
    orgId: string;
    channelAccountId: string;
    name: string;
    language: string;
    category: TemplateCategory | null;
    providerCategory: string | null;
    status: TemplateStatus;
    providerStatus: string;
    providerTemplateId: string | null;
    headerText: string | null;
    bodyText: string;
    footerText: string | null;
    variableCount: number;
    rejectionReason: string | null;
    qualityScore: string | null;
  }): Promise<MessageTemplate> {
    const now = new Date();
    const row = await db
      .insertInto('commerce_templates')
      .values({
        org_id: params.orgId,
        channel_account_id: params.channelAccountId,
        name: params.name,
        language: params.language,
        category: params.category,
        provider_category: params.providerCategory,
        status: params.status,
        provider_status: params.providerStatus,
        provider_template_id: params.providerTemplateId,
        header_text: params.headerText,
        body_text: params.bodyText,
        footer_text: params.footerText,
        variable_count: params.variableCount,
        rejection_reason: params.rejectionReason,
        quality_score: params.qualityScore,
        last_synced_at: now,
      })
      .onConflict((oc) =>
        oc.columns(['channel_account_id', 'name', 'language']).doUpdateSet((eb) => ({
          // Category is refreshed from Meta rather than kept from the submission: Meta
          // re-categorizes templates it disagrees with, and the category decides the price.
          category: eb.ref('excluded.category'),
          provider_category: eb.ref('excluded.provider_category'),
          status: eb.ref('excluded.status'),
          provider_status: eb.ref('excluded.provider_status'),
          provider_template_id: eb.ref('excluded.provider_template_id'),
          header_text: eb.ref('excluded.header_text'),
          body_text: eb.ref('excluded.body_text'),
          footer_text: eb.ref('excluded.footer_text'),
          variable_count: eb.ref('excluded.variable_count'),
          rejection_reason: eb.ref('excluded.rejection_reason'),
          quality_score: eb.ref('excluded.quality_score'),
          last_synced_at: eb.ref('excluded.last_synced_at'),
          updated_at: now,
        })),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return toTemplate(row);
  }

  /**
   * Apply what a template webhook carries, and only that.
   *
   * Keyed on name and language rather than on Meta's template id, because that is what the webhooks
   * actually send. It touches nothing else: they do not restate the body, and a partial write that
   * blanked the body would leave a template that cannot be sent for a reason nobody could see.
   *
   * Status and category are BOTH optional, because Meta sends them separately.
   * `message_template_status_update` carries an approval or a pause with no category;
   * `message_template_category_update` carries a re-categorization with no status. Writing a
   * placeholder for whichever is absent would let a category change silently reset an approved
   * template to `pending`, which stops every campaign using it.
   *
   * Returns null when no row matched — an update for a template this build has never synced, which
   * is ordinary the first time a client creates one in WhatsApp Manager.
   */
  async applyStatus(params: {
    channelAccountId: string;
    name: string;
    language: string;
    status: TemplateStatus | null;
    providerStatus: string | null;
    rejectionReason: string | null;
    category: TemplateCategory | null;
    providerCategory: string | null;
  }): Promise<MessageTemplate | null> {
    const row = await db
      .updateTable('commerce_templates')
      .set((eb) => ({
        ...(params.status === null || params.providerStatus === null
          ? {}
          : {
              status: params.status,
              provider_status: params.providerStatus,
              rejection_reason: params.rejectionReason,
            }),
        // Gated on providerCategory, not on our mapped category: an event whose category this build
        // cannot map still writes category = null WITH Meta's verbatim word, so the re-filing is
        // recorded rather than dropped along with the word that would explain it.
        ...(params.providerCategory === null
          ? {}
          : { category: params.category, provider_category: params.providerCategory }),
        last_synced_at: new Date(),
        updated_at: new Date(),
        // Named to keep the expression builder in use whichever branches above are taken, so this
        // object's shape does not depend on which fields the webhook happened to carry.
        name: eb.ref('commerce_templates.name'),
      }))
      .where('channel_account_id', '=', params.channelAccountId)
      .where('name', '=', params.name)
      .where('language', '=', params.language)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? null : toTemplate(row);
  }

  async delete(orgId: string, templateId: string): Promise<boolean> {
    const result = await db
      .deleteFrom('commerce_templates')
      .where('org_id', '=', orgId)
      .where('id', '=', templateId)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  /**
   * Which broadcasts still point at this template, by name.
   *
   * Asked before a delete, and before nothing else. A broadcast whose template was deleted fails at
   * Meta per recipient, mid-run, having already reached the first few hundred — so the delete is
   * refused and names the campaigns instead. Only the states that can still send are counted: a
   * completed campaign's template is historical, and holding a template hostage to a campaign that
   * finished last year would make templates undeletable in practice.
   */
  async broadcastsUsingTemplate(orgId: string, templateId: string): Promise<string[]> {
    const rows = await db
      .selectFrom('commerce_broadcasts')
      .select('name')
      .where('org_id', '=', orgId)
      .where('template_id', '=', templateId)
      .where('status', 'in', ['scheduled', 'running', 'paused'])
      .execute();
    return rows.map((row) => row.name);
  }
}

export const templateRepository = new TemplateRepository();
