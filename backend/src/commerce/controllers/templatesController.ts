import type { Request, Response } from 'express';
import { z } from 'zod';
import type {
  CreateMessageTemplateResponse,
  DeleteMessageTemplateResponse,
  ListMessageTemplatesResponse,
  SyncMessageTemplatesResponse,
} from '@stewra/shared-types';
import { TEMPLATE_CATEGORIES } from '@stewra/shared-types';
import { BaseController } from '../../controllers/baseController.js';
import { templateService } from '../services/templateService.js';
import { orgContext } from '../middleware/requireOrgMember.js';
import { parse } from '../../utils/validate.js';

const templateParamsSchema = z.object({ templateId: z.string().uuid() });

const listQuerySchema = z.object({
  channelAccountId: z.string().uuid().optional(),
});

/**
 * Meta's language codes are its own spelling of BCP-47 — `en`, `en_US`, `pt_BR`, `zh_CN`. Validated
 * by shape rather than against a list: Meta adds locales, and a closed list here would refuse a
 * language Meta happily supports, with no way for the client to tell which of the two was wrong.
 */
const languageSchema = z
  .string()
  .regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, 'Language must look like "en" or "en_US".');

const createTemplateSchema = z.object({
  channelAccountId: z.string().uuid(),
  name: z.string().min(1).max(512),
  language: languageSchema,
  category: z.enum(TEMPLATE_CATEGORIES),
  headerText: z.string().max(60).nullable().optional(),
  bodyText: z.string().min(1).max(1024),
  footerText: z.string().max(60).nullable().optional(),
});

const syncSchema = z.object({ channelAccountId: z.string().uuid() });

/**
 * Message templates — Stewra's mirror of what Meta has approved.
 *
 * Every read here is served from the mirror. Nothing calls Graph on a page load: Meta rate-limits
 * template reads per WABA, and a list endpoint that reached out on every request would spend that
 * budget on people refreshing a page and have none left for the campaign that needs it. What keeps
 * the mirror honest is the hourly `template_sync` job, the `message_template_status_update` webhook,
 * and `POST /templates/sync` here for an operator who does not want to wait for either.
 */
class TemplatesController extends BaseController {
  private userId(req: Request): string {
    const userId = req.userId;
    if (userId === undefined) throw new Error('requireAuth middleware missing');
    return userId;
  }

  /** GET /orgs/:orgId/templates */
  async list(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const query = parse(listQuerySchema, req.query);
      const templates = await templateService.list(orgId, query.channelAccountId);
      const body: ListMessageTemplatesResponse = { templates };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'TemplatesController.list');
    }
  }

  /** POST /orgs/:orgId/templates */
  async create(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const input = parse(createTemplateSchema, req.body);
      const template = await templateService.create(orgId, this.userId(req), {
        channelAccountId: input.channelAccountId,
        name: input.name,
        language: input.language,
        category: input.category,
        headerText: input.headerText ?? null,
        bodyText: input.bodyText,
        footerText: input.footerText ?? null,
      });
      const body: CreateMessageTemplateResponse = { template };
      // 201 for a row that now exists here, not for an approval — the template comes back `pending`
      // and Meta decides. The status field is the honest part of this response.
      this.handleSuccess(res, body, 201);
    } catch (error) {
      this.handleError(error, res, 'TemplatesController.create');
    }
  }

  /** POST /orgs/:orgId/templates/sync */
  async sync(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const input = parse(syncSchema, req.body);
      const result = await templateService.syncForOrg(orgId, input.channelAccountId);
      const body: SyncMessageTemplatesResponse = result;
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'TemplatesController.sync');
    }
  }

  /** DELETE /orgs/:orgId/templates/:templateId */
  async remove(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const { templateId } = parse(templateParamsSchema, req.params);
      await templateService.remove(orgId, templateId);
      const body: DeleteMessageTemplateResponse = { deleted: true };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'TemplatesController.remove');
    }
  }
}

export const templatesController = new TemplatesController();
