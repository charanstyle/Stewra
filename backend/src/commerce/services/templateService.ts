import { z } from 'zod';
import type {
  CreateMessageTemplateRequest,
  MessageTemplate,
  SyncMessageTemplatesResponse,
} from '@stewra/shared-types';
import { graphRequest } from './metaGraph.js';
import {
  assertHeaderAndFooter,
  assertTemplateName,
  countTemplateVariables,
  mapTemplateCategory,
  mapTemplateStatus,
} from './templateBody.js';
import { channelAccountService } from './channelAccountService.js';
import { channelAccountRepository } from '../repositories/channelAccountRepository.js';
import type { ChannelAccountRow } from '../repositories/channelAccountRepository.js';
import { templateRepository } from '../repositories/templateRepository.js';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

/** One page of Meta's template list. 100 is its own maximum for this edge. */
const PAGE_SIZE = 100;
/**
 * How many pages a single sync will walk.
 *
 * A ceiling rather than an unbounded loop, because `paging.cursors.after` comes from a remote
 * service and a cursor that never advances would spin forever against Meta's rate limit. At 100 per
 * page this is 5,000 templates for one WABA — far past anything real. Hitting it is logged and
 * suppresses the reconciliation pass below, so a truncated read can never be mistaken for a
 * complete one.
 */
const MAX_PAGES = 50;

/** The fields worth asking for. Anything absent from this list is absent from the response. */
const LIST_FIELDS = 'name,language,status,category,id,components,rejected_reason,quality_score';

const componentSchema = z.object({
  type: z.string(),
  format: z.string().optional(),
  text: z.string().optional(),
});

const remoteTemplateSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  language: z.string(),
  status: z.string(),
  category: z.string(),
  components: z.array(componentSchema).optional(),
  rejected_reason: z.string().optional(),
  quality_score: z.object({ score: z.string().optional() }).optional(),
});

type RemoteTemplate = z.infer<typeof remoteTemplateSchema>;

const listResponseSchema = z.object({
  data: z.array(remoteTemplateSchema),
  paging: z
    .object({ cursors: z.object({ after: z.string().optional() }).optional() })
    .optional(),
});

const createResponseSchema = z.object({
  id: z.string(),
  status: z.string().optional(),
  category: z.string().optional(),
});

const deleteResponseSchema = z.object({ success: z.boolean().optional() });

/** Pull the text of one component out of Meta's array. Absent is null, not an empty string. */
function componentText(template: RemoteTemplate, type: string): string | null {
  const found = template.components?.find((c) => c.type.toUpperCase() === type);
  if (found === undefined) return null;
  // A HEADER whose format is IMAGE/VIDEO/DOCUMENT carries no text at all. Recording an empty string
  // would make the mirror claim a header that reads as blank rather than one that is not text.
  return found.text ?? null;
}

/**
 * WhatsApp message templates: the mirror, and the two things that keep it honest.
 *
 * Nothing here treats the local row as authoritative. Meta owns the object; this owns a copy, a
 * record of when the copy was last confirmed, and one gate — {@link assertSendable} — that every
 * business-initiated send passes through.
 *
 * Creating a template is a REQUEST. It comes back `pending` and Meta decides, and the client is told
 * that in those words rather than being left to infer it from an enum.
 */
class TemplateService {
  async list(orgId: string, channelAccountId?: string): Promise<MessageTemplate[]> {
    return templateRepository.listForOrg(orgId, channelAccountId);
  }

  async get(orgId: string, templateId: string): Promise<MessageTemplate> {
    const template = await templateRepository.findById(orgId, templateId);
    if (template === null) throw new NotFoundError('Template not found');
    return template;
  }

  /**
   * Submit a new template to Meta and mirror the answer.
   *
   * Validation runs before the Graph call and duplicates rules Meta enforces anyway. That is not
   * redundancy — Meta's rejection for a numbering gap is a code and a sentence about parameters,
   * while the client needs to be told which placeholder is wrong in their own body.
   *
   * The row is written only AFTER Meta accepts. The reverse order would leave a local template a
   * client could schedule a campaign against, with no object at Meta behind it, and the failure
   * would surface at dispatch rather than at creation.
   */
  async create(
    orgId: string,
    userId: string,
    request: CreateMessageTemplateRequest,
  ): Promise<MessageTemplate> {
    assertTemplateName(request.name);
    const headerText = request.headerText ?? null;
    const footerText = request.footerText ?? null;
    assertHeaderAndFooter(headerText, footerText);
    const variableCount = countTemplateVariables(request.bodyText);
    const bodyText = request.bodyText.trim();

    const account = await this.requireWhatsappAccount(orgId, request.channelAccountId);

    const existing = await templateRepository.listForAccount(account.id);
    if (existing.some((t) => t.name === request.name && t.language === request.language)) {
      throw new ConflictError(
        `A template named "${request.name}" already exists in ${request.language} on this account.`,
      );
    }

    const resolved = await channelAccountService.resolve(account);
    const created = await graphRequest(
      {
        path: `${account.externalAccountId}/message_templates`,
        method: 'POST',
        accessToken: resolved.accessToken,
        body: {
          name: request.name,
          language: request.language,
          category: request.category.toUpperCase(),
          components: [
            ...(headerText === null || headerText.length === 0
              ? []
              : [{ type: 'HEADER', format: 'TEXT', text: headerText }]),
            {
              type: 'BODY',
              text: bodyText,
              // Meta refuses a body with placeholders and no example values — it uses them to review
              // what the template will actually look like. Positional and generated, because this
              // API takes no examples from the client; a template needing realistic samples for
              // approval is one to build in WhatsApp Manager and let the sync pick up.
              ...(variableCount > 0
                ? {
                    example: {
                      body_text: [
                        Array.from({ length: variableCount }, (_, i) => `Sample ${i + 1}`),
                      ],
                    },
                  }
                : {}),
            },
            ...(footerText === null || footerText.length === 0
              ? []
              : [{ type: 'FOOTER', text: footerText }]),
          ],
        },
      },
      createResponseSchema,
    );

    // Meta returns the category it ACTUALLY assigned, which is not always the one submitted — it
    // re-files a template it reads as marketing regardless of what the request said, and that
    // decides the rate. Taking the request's word for it here would misprice every send.
    const providerCategory = created.category ?? request.category.toUpperCase();
    const providerStatus = created.status ?? 'PENDING';

    return templateRepository.create({
      orgId,
      channelAccountId: account.id,
      name: request.name,
      language: request.language,
      category: mapTemplateCategory(providerCategory),
      providerCategory,
      status: mapTemplateStatus(providerStatus),
      providerStatus,
      providerTemplateId: created.id,
      headerText: headerText === null || headerText.length === 0 ? null : headerText,
      bodyText,
      footerText: footerText === null || footerText.length === 0 ? null : footerText,
      variableCount,
      createdByUserId: userId,
    });
  }

  /** Re-read one account's templates from Meta, on a member's request. */
  async syncForOrg(
    orgId: string,
    channelAccountId: string,
  ): Promise<SyncMessageTemplatesResponse> {
    const account = await this.requireWhatsappAccount(orgId, channelAccountId);
    return this.syncAccount(account);
  }

  /**
   * The PULL half of keeping the mirror current — also the `template_sync` job's whole body.
   *
   * Walks every template Meta holds for the account, upserts each, and then reconciles: a local row
   * Meta no longer lists is marked `unknown`, which is not `approved`, so it stops being sendable.
   * A template deleted at Meta but left `approved` here is the single most expensive drift there is
   * — every recipient of a campaign using it is rejected individually, after the campaign has
   * started.
   *
   * That reconciliation runs ONLY when every page was read. A sync that stopped early has not seen
   * Meta's full list, and marking the unseen remainder missing would disable healthy templates
   * wholesale.
   */
  async syncAccount(account: ChannelAccountRow): Promise<SyncMessageTemplatesResponse> {
    const resolved = await channelAccountService.resolve(account);

    const remote: RemoteTemplate[] = [];
    let after: string | undefined;
    let complete = false;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await graphRequest(
        {
          path: `${account.externalAccountId}/message_templates`,
          accessToken: resolved.accessToken,
          query: {
            fields: LIST_FIELDS,
            limit: String(PAGE_SIZE),
            ...(after === undefined ? {} : { after }),
          },
        },
        listResponseSchema,
      );
      remote.push(...response.data);
      after = response.paging?.cursors?.after;
      if (after === undefined || response.data.length === 0) {
        complete = true;
        break;
      }
    }

    if (!complete) {
      logger.warn('commerce: template sync stopped at the page ceiling', {
        channelAccountId: account.id,
        orgId: account.orgId,
        pages: MAX_PAGES,
        seen: remote.length,
      });
    }

    const before = await templateRepository.listForAccount(account.id);
    const previous = new Map(before.map((t) => [`${t.name} ${t.language}`, t]));

    const changed: MessageTemplate[] = [];
    for (const template of remote) {
      const providerStatus = template.status;
      const status = mapTemplateStatus(providerStatus);
      const rejectionReason =
        template.rejected_reason === undefined || template.rejected_reason.toUpperCase() === 'NONE'
          ? null
          : template.rejected_reason;
      const bodyText = componentText(template, 'BODY');
      if (bodyText === null) {
        // Every WhatsApp template has a body; one that arrives without it is a shape this build does
        // not understand. Skipped and named rather than stored with an invented body, which would be
        // a sendable-looking row whose text nobody chose.
        logger.warn('commerce: template from Meta has no body component', {
          channelAccountId: account.id,
          name: template.name,
          language: template.language,
        });
        continue;
      }

      const stored = await templateRepository.upsertFromMeta({
        orgId: account.orgId,
        channelAccountId: account.id,
        name: template.name,
        language: template.language,
        category: mapTemplateCategory(template.category),
        providerCategory: template.category,
        status,
        providerStatus,
        providerTemplateId: template.id ?? null,
        headerText: componentText(template, 'HEADER'),
        bodyText,
        footerText: componentText(template, 'FOOTER'),
        // Derived from what Meta actually holds, not from what was submitted. A template edited in
        // WhatsApp Manager to take another variable would otherwise keep the old count and be
        // dispatched one value short.
        variableCount: countRemoteVariables(bodyText),
        rejectionReason,
        qualityScore: template.quality_score?.score ?? null,
      });

      const was = previous.get(`${template.name} ${template.language}`);
      if (was === undefined || was.status !== stored.status || was.category !== stored.category) {
        changed.push(stored);
      }
    }

    if (complete) {
      const seen = new Set(remote.map((t) => `${t.name} ${t.language}`));
      for (const local of before) {
        const key = `${local.name} ${local.language}`;
        if (seen.has(key)) continue;
        if (local.providerTemplateId === null && local.status === 'pending') {
          // Submitted through this build moments ago and not yet visible on the list edge. Not
          // missing — not yet indexed.
          continue;
        }
        const applied = await templateRepository.applyStatus({
          channelAccountId: account.id,
          name: local.name,
          language: local.language,
          status: 'unknown',
          providerStatus: 'MISSING_AT_META',
          rejectionReason: 'Meta no longer lists this template. It may have been deleted.',
          category: null,
          providerCategory: null,
        });
        if (applied !== null && local.status !== 'unknown') changed.push(applied);
      }
    }

    return { synced: remote.length, changed };
  }

  /**
   * The PUSH half: one template webhook event, either kind.
   *
   * `providerStatus` is null on a `message_template_category_update`, which carries no status at
   * all — and passing null through is what stops a re-categorization from resetting an approved
   * template to anything.
   *
   * Returns false when no local row matched. That is ordinary rather than exceptional — a client who
   * builds a template in WhatsApp Manager gets its approval webhook before any sync has mirrored it
   * — so the caller logs it and moves on rather than treating it as a fault.
   */
  async applyStatusUpdate(params: {
    account: ChannelAccountRow;
    name: string;
    language: string;
    providerStatus: string | null;
    reason: string | null;
    providerCategory: string | null;
  }): Promise<boolean> {
    const applied = await templateRepository.applyStatus({
      channelAccountId: params.account.id,
      name: params.name,
      language: params.language,
      status: params.providerStatus === null ? null : mapTemplateStatus(params.providerStatus),
      providerStatus: params.providerStatus,
      rejectionReason:
        params.reason === null || params.reason.toUpperCase() === 'NONE' ? null : params.reason,
      category: params.providerCategory === null ? null : mapTemplateCategory(params.providerCategory),
      providerCategory: params.providerCategory,
    });
    return applied !== null;
  }

  /**
   * Delete a template at Meta and locally.
   *
   * Refused while a campaign that can still send points at it. `commerce_broadcasts.template_id` is
   * `ON DELETE RESTRICT`, so the database would refuse this anyway — but it would refuse with a
   * foreign-key violation, and a client deserves the names of the campaigns holding it instead.
   */
  async remove(orgId: string, templateId: string): Promise<void> {
    const template = await this.get(orgId, templateId);

    const blocking = await templateRepository.broadcastsUsingTemplate(orgId, templateId);
    if (blocking.length > 0) {
      throw new ConflictError(
        `This template is used by ${blocking.length} campaign(s) that have not finished: ${blocking.join(', ')}. ` +
          'Cancel them first, or leave the template in place.',
      );
    }

    if (template.providerTemplateId !== null) {
      const account = await this.requireWhatsappAccount(orgId, template.channelAccountId);
      const resolved = await channelAccountService.resolve(account);
      // `hsm_id` scopes the delete to this one language. Deleting by name alone removes every
      // language of that name at Meta, which would silently take out the client's other markets.
      await graphRequest(
        {
          path: `${account.externalAccountId}/message_templates`,
          method: 'DELETE',
          accessToken: resolved.accessToken,
          query: { hsm_id: template.providerTemplateId, name: template.name },
        },
        deleteResponseSchema,
      );
    }

    await templateRepository.delete(orgId, templateId);
  }

  /**
   * The send gate. Every business-initiated send resolves its template through here.
   *
   * Two refusals, and both are the kind that must happen BEFORE a campaign starts rather than per
   * recipient in the middle of one:
   *
   *  - a template that is not `approved` right now, whatever it was when the campaign was scheduled;
   *  - a variable count that does not match what the campaign supplies.
   *
   * The second is checked against the mirror's derived count, which is why that count is derived.
   */
  async assertSendable(
    orgId: string,
    templateId: string,
    variableCount: number,
  ): Promise<MessageTemplate> {
    const template = await this.get(orgId, templateId);
    if (template.status !== 'approved') {
      throw new ValidationError('Validation failed', [
        {
          field: 'templateId',
          message:
            `Template "${template.name}" is ${template.status} at Meta` +
            `${template.rejectionReason === null ? '' : ` (${template.rejectionReason})`}. ` +
            'Only approved templates can be sent.',
        },
      ]);
    }
    if (template.variableCount !== variableCount) {
      throw new ValidationError('Validation failed', [
        {
          field: 'variables',
          message: `Template "${template.name}" needs exactly ${template.variableCount} variable(s); ${variableCount} supplied.`,
        },
      ]);
    }
    return template;
  }

  /**
   * The account a template operation acts on, verified to be this org's and to be WhatsApp.
   *
   * Instagram and Messenger have no template concept at all — they are reply-only — so a template
   * route pointed at one of those accounts is a mistake worth naming rather than a Graph 404.
   */
  private async requireWhatsappAccount(
    orgId: string,
    channelAccountId: string,
  ): Promise<ChannelAccountRow> {
    const account = await channelAccountRepository.findForOrg(orgId, channelAccountId);
    if (account === null) throw new NotFoundError('Channel account not found');
    if (account.platform !== 'whatsapp_cloud') {
      throw new ValidationError('Validation failed', [
        {
          field: 'channelAccountId',
          message: `Templates exist on WhatsApp only; this account is ${account.platform}.`,
        },
      ]);
    }
    return account;
  }
}

/**
 * The placeholder count of a body Meta already accepted.
 *
 * Deliberately NOT `countTemplateVariables`: that one enforces submission rules, and a template
 * approved before those rules existed — or built in WhatsApp Manager, which allows shapes this build
 * does not submit — would throw and take the whole sync down with it. What matters at sync time is
 * how many values a send has to supply, and that is the highest placeholder number present.
 */
function countRemoteVariables(bodyText: string): number {
  const numbers = [...bodyText.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
  return numbers.length === 0 ? 0 : Math.max(...numbers);
}

export const templateService = new TemplateService();
