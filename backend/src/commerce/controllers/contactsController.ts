import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  COMMERCE_PLATFORMS,
  CONSENT_PURPOSES,
  CONSENT_SOURCES,
  CONSENT_STATES,
} from '@stewra/shared-types';
import type {
  AddContactTagResponse,
  CommerceContactWithTags,
  CreateCommerceContactResponse,
  DeleteCommerceTagResponse,
  GetCommerceContactResponse,
  ListCommerceContactsResponse,
  ListCommerceTagsResponse,
  RemoveContactTagResponse,
  UpdateCommerceContactResponse,
} from '@stewra/shared-types';
import { BaseController } from '../../controllers/baseController.js';
import { audienceService } from '../services/audienceService.js';
import type { ContactWithTags } from '../repositories/contactRepository.js';
import { orgContext } from '../middleware/requireOrgMember.js';
import { parse } from '../../utils/validate.js';

const contactParamsSchema = z.object({ contactId: z.string().uuid() });
const tagParamsSchema = z.object({ tagId: z.string().uuid() });
const contactTagParamsSchema = z.object({
  contactId: z.string().uuid(),
  tagId: z.string().uuid(),
});

const listContactsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  search: z.string().max(120).optional(),
  tag: z.string().max(64).optional(),
});

/**
 * `displayName` and every attribute value accept null, and null is not the same as absent here.
 * Absent leaves the field as it is; null clears it. A schema that collapsed the two would make
 * "remove this person's name" unexpressible, and the workaround every client then reaches for is the
 * empty string — which reads as a name that happens to be blank.
 */
const updateContactSchema = z.object({
  displayName: z.string().max(200).nullable().optional(),
  attributes: z.record(z.string(), z.string().nullable()).optional(),
});

const addTagSchema = z.object({ tag: z.string().min(1).max(64) });

/**
 * Creating a contact.
 *
 * `platform` defaults to `whatsapp_cloud` rather than being required, because it is the only
 * platform anything can be sent on today (`OUTBOUND_CAPABLE_PLATFORMS`) and making every client
 * state it would be ceremony. It is still accepted so the field exists the day a second one does.
 *
 * `consent` is all-or-nothing: a request either carries a complete provenance or none at all. There
 * is no shape here that records a state without a source, because a consent row whose origin is
 * unknown cannot be defended and would still satisfy the send gate.
 */
const createContactSchema = z.object({
  phoneE164: z.string().min(1).max(32),
  displayName: z.string().max(200).nullable().optional(),
  attributes: z.record(z.string(), z.string()).optional(),
  tags: z.array(z.string().min(1).max(64)).max(20).optional(),
  platform: z.enum(COMMERCE_PLATFORMS).optional(),
  consent: z
    .object({
      purpose: z.enum(CONSENT_PURPOSES),
      state: z.enum(CONSENT_STATES),
      source: z.enum(CONSENT_SOURCES),
      evidence: z.string().min(1).max(500),
    })
    .optional(),
});

function toContactResponse(found: ContactWithTags): CommerceContactWithTags {
  return { ...found.contact, tags: found.tags };
}

/**
 * Contacts and their labels — the people half of "who is this going to".
 *
 * Nothing in this controller decides whether anyone may be messaged. A tag is a note the business
 * keeps; consent is a fact about what the person agreed to, and it lives behind
 * `consentService.assertMaySend`. Keeping the two apart is what stops a label like "opted in" from
 * ever becoming permission by looking like it.
 */
class ContactsController extends BaseController {
  /** GET /orgs/:orgId/contacts */
  async list(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const query = parse(listContactsSchema, req.query);
      const found = await audienceService.listContacts({
        orgId,
        limit: query.limit ?? 100,
        ...(query.search === undefined ? {} : { search: query.search }),
        ...(query.tag === undefined ? {} : { tag: query.tag }),
      });
      const body: ListCommerceContactsResponse = { contacts: found.map(toContactResponse) };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'ContactsController.list');
    }
  }

  /** POST /orgs/:orgId/contacts */
  async create(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const userId = req.userId;
      if (userId === undefined) throw new Error('requireAuth middleware missing');
      const input = parse(createContactSchema, req.body);
      const result = await audienceService.createContact({
        orgId,
        platform: input.platform ?? 'whatsapp_cloud',
        phone: input.phoneE164,
        displayName: input.displayName ?? null,
        attributes: input.attributes,
        tags: input.tags ?? [],
        consent: input.consent,
        recordedByUserId: userId,
      });
      const body: CreateCommerceContactResponse = {
        contact: toContactResponse(result.contact),
        consent: result.consent,
      };
      this.handleSuccess(res, body, 201);
    } catch (error) {
      this.handleError(error, res, 'ContactsController.create');
    }
  }

  /** GET /orgs/:orgId/contacts/:contactId */
  async get(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const { contactId } = parse(contactParamsSchema, req.params);
      const found = await audienceService.getContact(orgId, contactId);
      const body: GetCommerceContactResponse = { contact: toContactResponse(found) };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'ContactsController.get');
    }
  }

  /** PATCH /orgs/:orgId/contacts/:contactId */
  async update(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const { contactId } = parse(contactParamsSchema, req.params);
      const input = parse(updateContactSchema, req.body);
      const found = await audienceService.updateContact({
        orgId,
        contactId,
        displayName: input.displayName,
        attributes: input.attributes,
      });
      const body: UpdateCommerceContactResponse = { contact: toContactResponse(found) };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'ContactsController.update');
    }
  }

  /** POST /orgs/:orgId/contacts/:contactId/tags */
  async addTag(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const { contactId } = parse(contactParamsSchema, req.params);
      const { tag } = parse(addTagSchema, req.body);
      const created = await audienceService.addContactTag(orgId, contactId, tag);
      const body: AddContactTagResponse = { tag: created };
      this.handleSuccess(res, body, 201);
    } catch (error) {
      this.handleError(error, res, 'ContactsController.addTag');
    }
  }

  /** DELETE /orgs/:orgId/contacts/:contactId/tags/:tagId */
  async removeTag(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const { contactId, tagId } = parse(contactTagParamsSchema, req.params);
      const removed = await audienceService.removeContactTag(orgId, contactId, tagId);
      const body: RemoveContactTagResponse = { removed };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'ContactsController.removeTag');
    }
  }

  /** GET /orgs/:orgId/tags */
  async listTags(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const tags = await audienceService.listTags(orgId);
      const body: ListCommerceTagsResponse = { tags };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'ContactsController.listTags');
    }
  }

  /** DELETE /orgs/:orgId/tags/:tagId */
  async deleteTag(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const { tagId } = parse(tagParamsSchema, req.params);
      const deleted = await audienceService.deleteTag(orgId, tagId);
      const body: DeleteCommerceTagResponse = { deleted };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'ContactsController.deleteTag');
    }
  }
}

export const contactsController = new ContactsController();
