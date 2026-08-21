// @skip-validation — this file IS the shared-types package. The api-contract guard requires a literal
// `@stewra/shared-types` import in any file declaring *Request/*Response types, which is unsatisfiable
// here (it would be a self-import); every sibling in this directory imports relatively for the same
// reason. Remove this marker if the guard ever learns to exclude packages/shared-types/.
import type {
  OrgInvite,
  OrgMember,
  OrgMembership,
  OrgRole,
  Organization,
} from '../models/organization';

/**
 * The tenancy surface of the commerce plane. Every route below except org creation and invite
 * acceptance sits behind `requireOrgMember`, which resolves `:orgId`, verifies membership and
 * enforces a minimum {@link OrgRole}.
 */

/**
 * POST /orgs — create a further organization. The creator becomes its `owner`.
 *
 * Always a `business` org: the one `individual` org a person gets is created at signup and there is
 * never a second, so there is no kind to choose here.
 */
export interface CreateOrgRequest {
  readonly name: string;
  /**
   * Optional URL-safe handle. Derived from `name` when omitted; the server resolves collisions by
   * suffixing, so a client never has to retry on a taken slug.
   */
  readonly slug?: string;
}

export interface CreateOrgResponse {
  readonly org: Organization;
  readonly role: OrgRole;
}

/**
 * POST /orgs/:orgId/convert — turn an `individual` org into a `business` one. Owner only.
 *
 * The one way an individual account grows a team: the kind flips, the org takes the company's name,
 * and invites start being accepted. One-way — a business with members cannot become a person.
 */
export interface ConvertOrgRequest {
  readonly companyName: string;
}

export interface ConvertOrgResponse {
  readonly org: Organization;
}

/** GET /orgs — every organization the caller belongs to, with their own role in each. */
export interface ListOrgsResponse {
  readonly memberships: readonly OrgMembership[];
  /**
   * Which org the conversational surface currently acts on for this user. Null until they belong to
   * one. This exists because an inbound WhatsApp text carries no route param and no header — the
   * command layer has no other way to resolve a tenant. See PUT /orgs/active.
   */
  readonly activeOrgId: string | null;
}

/** GET /orgs/:orgId */
export interface GetOrgResponse {
  readonly org: Organization;
  readonly role: OrgRole;
}

/**
 * PUT /orgs/active — set which organization the caller's conversational turns act on.
 *
 * Deliberately a per-USER setting rather than a per-session one: the WhatsApp surface has no session
 * to hang it on, and "which business am I texting about" must survive across devices and reconnects.
 * Stored in `commerce_active_orgs` (migration 039).
 */
export interface SetActiveOrgRequest {
  readonly orgId: string;
}

export interface SetActiveOrgResponse {
  readonly activeOrgId: string;
}

/** GET /orgs/:orgId/members */
export interface ListOrgMembersResponse {
  readonly members: readonly OrgMember[];
  readonly invites: readonly OrgInvite[];
}

/** POST /orgs/:orgId/invites — invite by email. Requires `admin` or above. */
export interface CreateOrgInviteRequest {
  readonly email: string;
  readonly role: OrgRole;
}

export interface CreateOrgInviteResponse {
  readonly invite: OrgInvite;
  /**
   * The invite link's opaque token, returned exactly ONCE — it is stored hashed, so the server
   * cannot show it again. Same rule as the bridge and runner device tokens.
   */
  readonly token: string;
}

/** POST /orgs/invites/accept — redeemed by the invited user, who must already have a Stewra account. */
export interface AcceptOrgInviteRequest {
  readonly token: string;
}

export interface AcceptOrgInviteResponse {
  readonly org: Organization;
  readonly role: OrgRole;
}

/** DELETE /orgs/:orgId/invites/:inviteId — requires `admin` or above. */
export interface DeleteOrgInviteResponse {
  readonly revoked: boolean;
}

/** PATCH /orgs/:orgId/members/:memberId — change a member's role. Requires `admin` or above. */
export interface UpdateOrgMemberRequest {
  readonly role: OrgRole;
}

export interface UpdateOrgMemberResponse {
  readonly member: OrgMember;
}

/**
 * DELETE /orgs/:orgId/members/:memberId — remove a member. Requires `admin` or above.
 *
 * The server refuses to remove (or demote) the last `owner`: an organization with no owner has no
 * one who can pay for it or delete it, and no path back to having one.
 */
export interface DeleteOrgMemberResponse {
  readonly removed: boolean;
}
