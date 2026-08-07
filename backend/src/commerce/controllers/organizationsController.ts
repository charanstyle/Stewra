import type { Request, Response } from 'express';
import { z } from 'zod';
import type {
  AcceptOrgInviteResponse,
  CreateOrgInviteResponse,
  CreateOrgResponse,
  DeleteOrgInviteResponse,
  DeleteOrgMemberResponse,
  GetOrgResponse,
  ListOrgMembersResponse,
  ListOrgsResponse,
  SetActiveOrgResponse,
  UpdateOrgMemberResponse,
} from '@stewra/shared-types';
import { ORG_ROLES } from '@stewra/shared-types';
import { BaseController } from '../../controllers/baseController.js';
import { organizationService } from '../services/organizationService.js';
import { orgContext } from '../middleware/requireOrgMember.js';
import { organizationRepository } from '../repositories/organizationRepository.js';
import { NotFoundError } from '../../utils/errors.js';
import { parse } from '../../utils/validate.js';

const roleSchema = z.enum(ORG_ROLES);

const createOrgSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(48).optional(),
});
const setActiveOrgSchema = z.object({ orgId: z.string().uuid() });
const createInviteSchema = z.object({ email: z.string().email(), role: roleSchema });
const acceptInviteSchema = z.object({ token: z.string().min(1).max(200) });
const updateMemberSchema = z.object({ role: roleSchema });
const memberParamsSchema = z.object({ memberId: z.string().uuid() });
const inviteParamsSchema = z.object({ inviteId: z.string().uuid() });

/**
 * The tenancy REST surface. Everything under `/orgs/:orgId` sits behind `requireOrgMember`, which
 * has already resolved membership and the minimum role by the time these methods run — so they read
 * the tenant from {@link orgContext} and never from the request body.
 */
class OrganizationsController extends BaseController {
  private userId(req: Request): string {
    const userId = req.userId;
    if (userId === undefined) throw new Error('requireAuth middleware missing');
    return userId;
  }

  /** POST /orgs — create an organization; the caller becomes its owner. */
  async create(req: Request, res: Response): Promise<void> {
    try {
      const { name, slug } = parse(createOrgSchema, req.body);
      const created = await organizationService.createOrg(this.userId(req), name, slug);
      const body: CreateOrgResponse = created;
      this.handleSuccess(res, body, 201);
    } catch (error) {
      this.handleError(error, res, 'OrganizationsController.create');
    }
  }

  /** GET /orgs — every organization the caller belongs to, plus their active one. */
  async list(req: Request, res: Response): Promise<void> {
    try {
      const { memberships, activeOrgId } = await organizationService.listOrgs(this.userId(req));
      const body: ListOrgsResponse = { memberships, activeOrgId };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'OrganizationsController.list');
    }
  }

  /** PUT /orgs/active — point the caller's conversational surface at one organization. */
  async setActive(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = parse(setActiveOrgSchema, req.body);
      const activeOrgId = await organizationService.setActiveOrg(this.userId(req), orgId);
      const body: SetActiveOrgResponse = { activeOrgId };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'OrganizationsController.setActive');
    }
  }

  /** POST /orgs/invites/accept — redeem an invite token. Not org-scoped: the token names the org. */
  async acceptInvite(req: Request, res: Response): Promise<void> {
    try {
      const { token } = parse(acceptInviteSchema, req.body);
      const accepted = await organizationService.acceptInvite(this.userId(req), token);
      const body: AcceptOrgInviteResponse = accepted;
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'OrganizationsController.acceptInvite');
    }
  }

  /** GET /orgs/:orgId */
  async get(req: Request, res: Response): Promise<void> {
    try {
      const { orgId, role } = orgContext(req);
      const membership = await organizationRepository.findMembership(this.userId(req), orgId);
      if (membership === null) {
        // requireOrgMember just confirmed this membership, so its disappearance is a real anomaly.
        throw new NotFoundError('Organization not found');
      }
      const body: GetOrgResponse = { org: membership.org, role };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'OrganizationsController.get');
    }
  }

  /** GET /orgs/:orgId/members */
  async listMembers(req: Request, res: Response): Promise<void> {
    try {
      const { orgId, role } = orgContext(req);
      const { members, invites } = await organizationService.listMembers(orgId, role);
      const body: ListOrgMembersResponse = { members, invites };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'OrganizationsController.listMembers');
    }
  }

  /** POST /orgs/:orgId/invites — mint an invite. The token is returned exactly once. */
  async createInvite(req: Request, res: Response): Promise<void> {
    try {
      const { orgId, role: actorRole } = orgContext(req);
      const { email, role } = parse(createInviteSchema, req.body);
      const { invite, token } = await organizationService.createInvite({
        orgId,
        actorId: this.userId(req),
        actorRole,
        email,
        role,
      });
      const body: CreateOrgInviteResponse = { invite, token };
      this.handleSuccess(res, body, 201);
    } catch (error) {
      this.handleError(error, res, 'OrganizationsController.createInvite');
    }
  }

  /** DELETE /orgs/:orgId/invites/:inviteId */
  async revokeInvite(req: Request, res: Response): Promise<void> {
    try {
      const { orgId } = orgContext(req);
      const { inviteId } = parse(inviteParamsSchema, req.params);
      const revoked = await organizationService.revokeInvite(orgId, inviteId);
      const body: DeleteOrgInviteResponse = { revoked };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'OrganizationsController.revokeInvite');
    }
  }

  /** PATCH /orgs/:orgId/members/:memberId */
  async updateMember(req: Request, res: Response): Promise<void> {
    try {
      const { orgId, role: actorRole } = orgContext(req);
      const { memberId } = parse(memberParamsSchema, req.params);
      const { role } = parse(updateMemberSchema, req.body);
      const member = await organizationService.updateMemberRole({
        orgId,
        memberId,
        actorRole,
        role,
      });
      const body: UpdateOrgMemberResponse = { member };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'OrganizationsController.updateMember');
    }
  }

  /** DELETE /orgs/:orgId/members/:memberId */
  async removeMember(req: Request, res: Response): Promise<void> {
    try {
      const { orgId, role: actorRole } = orgContext(req);
      const { memberId } = parse(memberParamsSchema, req.params);
      const removed = await organizationService.removeMember({ orgId, memberId, actorRole });
      const body: DeleteOrgMemberResponse = { removed };
      this.handleSuccess(res, body);
    } catch (error) {
      this.handleError(error, res, 'OrganizationsController.removeMember');
    }
  }
}

export const organizationsController = new OrganizationsController();
