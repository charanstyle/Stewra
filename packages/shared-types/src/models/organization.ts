import type { ISODateString, UUID } from '../common/base';

/**
 * An ORGANIZATION is the tenant of the commerce plane — a client business that runs its commercial
 * funnel through Stewra. It is the scope key for every commerce table, in the way `user_id` is the
 * scope key for the personal-assistant tables.
 *
 * The two planes deliberately do not share a scope. A `users` row is an authentication identity and
 * is shared between them; membership (`org_members`) is the only join. A commerce query that filters
 * by `user_id` instead of `org_id` is a bug, because a user may belong to several organizations and
 * an organization outlives any one member.
 */
export interface Organization {
  readonly id: UUID;
  readonly name: string;
  /** URL-safe handle, unique across the install. Lowercase, used in paths and in chat disambiguation. */
  readonly slug: string;
  readonly status: OrgStatus;
  readonly createdAt: ISODateString;
}

export const ORG_STATUSES = ['active', 'suspended'] as const;

/** Derived from the list above, so the runtime values and the type can never drift apart. */
export type OrgStatus = (typeof ORG_STATUSES)[number];

/**
 * Roles inside an organization, ordered from most to least privileged. The ordering is meaningful:
 * {@link roleMeetsMinimum} treats a role as satisfying any requirement at or below its own rank, so
 * routes declare the *minimum* role they need rather than enumerating every role that may pass.
 *
 * Distinct from `UserRole` in models/user.ts, which is install-wide and — as of today — stored but
 * never enforced anywhere. This one has teeth: it is checked on every commerce route.
 *
 * - `owner`    — billing and deletion. Exactly one org cannot be left without one.
 * - `admin`    — everything except billing and deleting the org.
 * - `marketer` — creates and sends campaigns; connects channels.
 * - `agent`    — works the shared inbox; replies to customers, sends nothing in bulk.
 * - `viewer`   — read-only.
 */
export const ORG_ROLES = ['owner', 'admin', 'marketer', 'agent', 'viewer'] as const;

export type OrgRole = (typeof ORG_ROLES)[number];

/**
 * True when `role` is at least as privileged as `minimum`, by position in {@link ORG_ROLES}.
 *
 * Lives in shared-types rather than the backend so the website can grey out an action the server
 * would reject, instead of offering it and surfacing a 403. The server check remains the real one —
 * this is for the UI's benefit, never a substitute for `requireOrgMember`.
 */
export function roleMeetsMinimum(role: OrgRole, minimum: OrgRole): boolean {
  return ORG_ROLES.indexOf(role) <= ORG_ROLES.indexOf(minimum);
}

/** One person's membership of one organization, as returned to clients. */
export interface OrgMember {
  readonly id: UUID;
  readonly userId: UUID;
  readonly orgId: UUID;
  readonly role: OrgRole;
  /** Denormalized from `users` for display, so a member list is one query. */
  readonly displayName: string;
  readonly email: string;
  readonly createdAt: ISODateString;
}

/** An organization as seen by one of its members — the org plus that member's own role in it. */
export interface OrgMembership {
  readonly org: Organization;
  readonly role: OrgRole;
}

export const ORG_INVITE_STATUSES = ['pending', 'accepted', 'revoked', 'expired'] as const;

export type OrgInviteStatus = (typeof ORG_INVITE_STATUSES)[number];

/**
 * An invitation to join an organization, addressed to an email. Mirrors `contact_invites`
 * (migration 014) in shape, with one deliberate difference: the token is stored HASHED and the
 * plaintext is returned exactly once, at creation — the same rule the bridge and runner device
 * tokens follow. An invite that can be read back out of the database is a credential at rest.
 */
export interface OrgInvite {
  readonly id: UUID;
  readonly orgId: UUID;
  readonly email: string;
  readonly role: OrgRole;
  readonly status: OrgInviteStatus;
  readonly invitedBy: UUID;
  readonly expiresAt: ISODateString;
  readonly createdAt: ISODateString;
  readonly acceptedAt: ISODateString | null;
}
