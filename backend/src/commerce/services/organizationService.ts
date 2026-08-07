import type {
  OrgInvite,
  OrgMember,
  OrgMembership,
  OrgRole,
  Organization,
} from '@stewra/shared-types';
import { roleMeetsMinimum } from '@stewra/shared-types';
import { organizationRepository, slugify } from '../repositories/organizationRepository.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors.js';

/**
 * How long an invite link stays redeemable. A behaviour knob, not a target — seven days is long
 * enough to survive a weekend and short enough that a link leaked from an inbox has usually expired.
 */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Tenancy rules for the commerce plane: who may join an organization, who may change someone else's
 * role, and which organization a user's conversational turns act on.
 *
 * The two invariants worth stating out loud, because everything else here exists to protect them:
 *
 *  1. **An organization always has at least one owner.** An org whose last owner is removed or
 *     demoted has nobody who can pay for it, invite into it, or delete it — and no path back.
 *  2. **Only an owner grants or removes the `owner` role.** Without this an `admin` could promote
 *     itself and take over the tenant, which makes the whole role hierarchy decorative.
 *
 * Membership itself is checked upstream by `requireOrgMember`; this service is handed an already
 * verified `actorRole` and never re-derives it.
 */
class OrganizationService {
  async createOrg(userId: string, name: string, slug?: string): Promise<{ org: Organization; role: OrgRole }> {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      throw new ValidationError('Validation failed', [
        { field: 'name', message: 'Organization name is required' },
      ]);
    }
    return organizationRepository.create({
      name: trimmed,
      slug: slugify(slug ?? trimmed),
      createdBy: userId,
    });
  }

  async listOrgs(userId: string): Promise<{ memberships: OrgMembership[]; activeOrgId: string | null }> {
    const [memberships, activeOrgId] = await Promise.all([
      organizationRepository.listForUser(userId),
      organizationRepository.findActiveOrgId(userId),
    ]);
    return { memberships, activeOrgId };
  }

  /**
   * Point the caller's conversational surface at an organization.
   *
   * Membership is re-checked here rather than trusted from the request body: this is the one write
   * that is NOT behind `requireOrgMember` (the org id arrives in the body, not the path), so it is
   * the one place a user could otherwise name a tenant they do not belong to.
   */
  async setActiveOrg(userId: string, orgId: string): Promise<string> {
    const membership = await organizationRepository.findMembership(userId, orgId);
    if (membership === null) {
      throw new NotFoundError('Organization not found');
    }
    await organizationRepository.setActiveOrgId(userId, orgId);
    return orgId;
  }

  /**
   * The org's people. `invites` is populated only for `admin` and above — a pending invite exposes
   * the email address of someone who has not joined yet, which is not a viewer's business.
   */
  async listMembers(
    orgId: string,
    actorRole: OrgRole,
  ): Promise<{ members: OrgMember[]; invites: OrgInvite[] }> {
    const members = await organizationRepository.listMembers(orgId);
    const invites = roleMeetsMinimum(actorRole, 'admin')
      ? await organizationRepository.listInvites(orgId)
      : [];
    return { members, invites };
  }

  async createInvite(params: {
    orgId: string;
    actorId: string;
    actorRole: OrgRole;
    email: string;
    role: OrgRole;
  }): Promise<{ invite: OrgInvite; token: string }> {
    const email = params.email.trim().toLowerCase();
    if (email.length === 0) {
      throw new ValidationError('Validation failed', [
        { field: 'email', message: 'An email address is required' },
      ]);
    }
    this.assertMayAssignRole(params.actorRole, params.role);

    return organizationRepository.createInvite({
      orgId: params.orgId,
      email,
      role: params.role,
      invitedBy: params.actorId,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    });
  }

  /**
   * Redeem an invite token. Every failure mode — unknown token, already redeemed, expired, addressed
   * to a different account — is rendered as the same 404, so a caller holding a guessed token learns
   * nothing about which of those it hit.
   */
  async acceptInvite(userId: string, token: string): Promise<{ org: Organization; role: OrgRole }> {
    const result = await organizationRepository.acceptInvite(token.trim(), userId);
    if (result === null) {
      throw new NotFoundError('That invite is not valid');
    }
    return result;
  }

  async revokeInvite(orgId: string, inviteId: string): Promise<boolean> {
    const revoked = await organizationRepository.revokeInvite(orgId, inviteId);
    if (!revoked) {
      throw new NotFoundError('Invite not found');
    }
    return true;
  }

  async updateMemberRole(params: {
    orgId: string;
    memberId: string;
    actorRole: OrgRole;
    role: OrgRole;
  }): Promise<OrgMember> {
    const member = await organizationRepository.findMemberById(params.orgId, params.memberId);
    if (member === null) {
      throw new NotFoundError('Member not found');
    }

    // Both directions are owner-only: granting the role, and taking it away from someone who has it.
    this.assertMayAssignRole(params.actorRole, params.role);
    this.assertMayAssignRole(params.actorRole, member.role);

    if (member.role === 'owner' && params.role !== 'owner') {
      await this.assertNotLastOwner(params.orgId);
    }

    await organizationRepository.updateMemberRole(params.orgId, params.memberId, params.role);

    const updated = (await organizationRepository.listMembers(params.orgId)).find(
      (m) => m.id === params.memberId,
    );
    if (updated === undefined) {
      // The row was there a moment ago; it vanishing mid-update is a real anomaly, not an empty result.
      throw new ConflictError('Member was removed while its role was being changed');
    }
    return updated;
  }

  async removeMember(params: {
    orgId: string;
    memberId: string;
    actorRole: OrgRole;
  }): Promise<boolean> {
    const member = await organizationRepository.findMemberById(params.orgId, params.memberId);
    if (member === null) {
      throw new NotFoundError('Member not found');
    }

    this.assertMayAssignRole(params.actorRole, member.role);
    if (member.role === 'owner') {
      await this.assertNotLastOwner(params.orgId);
    }

    await organizationRepository.removeMember(params.orgId, params.memberId);
    return true;
  }

  /**
   * Guard on the `owner` role in either direction. Anything below owner an `admin` may hand out; the
   * owner role itself may only be granted or revoked by someone who already holds it.
   */
  private assertMayAssignRole(actorRole: OrgRole, targetRole: OrgRole): void {
    if (targetRole === 'owner' && actorRole !== 'owner') {
      throw new ForbiddenError('Only an owner can grant or remove the owner role.', 'OWNER_ROLE_REQUIRED');
    }
  }

  private async assertNotLastOwner(orgId: string): Promise<void> {
    const owners = await organizationRepository.countOwners(orgId);
    if (owners <= 1) {
      throw new ConflictError(
        'This organization would be left without an owner. Promote another member to owner first.',
      );
    }
  }
}

export const organizationService = new OrganizationService();
