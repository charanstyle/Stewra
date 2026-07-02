import type { Request, Response } from 'express';
import { z } from 'zod';
import type {
  BlockContactResponse,
  ListContactsResponse,
  ListInvitesResponse,
  RespondInviteResponse,
  SearchUsersResponse,
  SendInviteResponse,
} from '@stewra/shared-types';
import { BaseController } from './baseController';
import { contactService } from '../services/contactService';
import { parse } from '../utils/validate';

const searchSchema = z.object({ query: z.string().min(1).max(200) });
const inviteSchema = z.object({ inviteeEmail: z.string().email() });
const respondParamsSchema = z.object({ id: z.string().uuid() });
const respondBodySchema = z.object({ action: z.enum(['accept', 'decline']) });
const blockSchema = z.object({ contactUserId: z.string().uuid(), block: z.boolean() });

/** Contacts + invites REST surface (all routes behind requireAuth + requireEmailVerification). */
class ContactsController extends BaseController {
  private userId(req: Request): string {
    const userId = req.userId;
    if (userId === undefined) throw new Error('requireAuth middleware missing');
    return userId;
  }

  /** GET /contacts/search?query= — find other users to add. */
  async search(req: Request, res: Response): Promise<void> {
    try {
      const { query } = parse(searchSchema, req.query);
      const users = await contactService.search(this.userId(req), query);
      const body: SearchUsersResponse = { users };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'ContactsController.search');
    }
  }

  /** GET /contacts — the caller's contact list. */
  async list(req: Request, res: Response): Promise<void> {
    try {
      const contacts = await contactService.list(this.userId(req));
      const body: ListContactsResponse = { contacts };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'ContactsController.list');
    }
  }

  /** POST /contacts/invites — invite someone by email. */
  async invite(req: Request, res: Response): Promise<void> {
    try {
      const { inviteeEmail } = parse(inviteSchema, req.body);
      const invite = await contactService.invite(this.userId(req), inviteeEmail);
      const body: SendInviteResponse = { invite };
      this.handleSuccess(res, body, 201);
    } catch (error) {
      this.handleError(error, res, 'ContactsController.invite');
    }
  }

  /** GET /contacts/invites — invites the caller sent and received. */
  async listInvites(req: Request, res: Response): Promise<void> {
    try {
      const { sent, received } = await contactService.listInvites(this.userId(req));
      const body: ListInvitesResponse = { sent, received };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'ContactsController.listInvites');
    }
  }

  /** POST /contacts/invites/:id/respond — accept or decline a pending invite. */
  async respondInvite(req: Request, res: Response): Promise<void> {
    try {
      const { id } = parse(respondParamsSchema, req.params);
      const { action } = parse(respondBodySchema, req.body);
      const { invite, contact } = await contactService.respondInvite(this.userId(req), id, action);
      const body: RespondInviteResponse = { invite, contact };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'ContactsController.respondInvite');
    }
  }

  /** POST /contacts/block — block or unblock a contact. */
  async block(req: Request, res: Response): Promise<void> {
    try {
      const { contactUserId, block } = parse(blockSchema, req.body);
      const contact = await contactService.setBlocked(this.userId(req), contactUserId, block);
      const body: BlockContactResponse = { contact };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'ContactsController.block');
    }
  }
}

export const contactsController = new ContactsController();
