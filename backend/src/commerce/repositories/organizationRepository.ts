import { createHash, randomBytes } from 'node:crypto';
import type { Selectable } from 'kysely';
import type {
  OrgInvite,
  OrgMember,
  OrgMembership,
  OrgRole,
  Organization,
} from '@stewra/shared-types';
import { db } from '../../database/index.js';
import type {
  OrgInvitesTable,
  OrgMembersTable,
  OrganizationsTable,
} from '../../database/types.js';

/**
 * Prefix so a leaked invite token is greppable and recognisable on sight — the same reasoning as
 * `stwbr_` on bridge tokens. A credential nobody can identify is one nobody reports.
 */
const TOKEN_PREFIX = 'stwoi_';

/** 32 random bytes, base64url. Shown once; only its SHA-256 is stored. */
function generateInviteToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** SHA-256, hex. Not bcrypt: there is no low-entropy password here to slow an attacker against. */
function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Turn a display name into a URL-safe handle. Not uniqueness-aware — `create` resolves collisions,
 * because a client should never have to retry a signup because someone else took a slug.
 */
export function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  // A name of pure punctuation ("!!!") reduces to nothing, and an empty slug would collide with
  // every other empty slug. Fall back to a random handle rather than rejecting the name.
  return base.length > 0 ? base : `org-${randomBytes(4).toString('hex')}`;
}

function toOrg(row: Selectable<OrganizationsTable>): Organization {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

function toInvite(row: Selectable<OrgInvitesTable>): OrgInvite {
  return {
    id: row.id,
    orgId: row.org_id,
    email: row.email,
    role: row.role,
    status: row.status,
    invitedBy: row.invited_by,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    acceptedAt: row.accepted_at?.toISOString() ?? null,
  };
}

/**
 * Organizations, membership and invites — the tenancy substrate of the commerce plane.
 *
 * SECURITY: {@link findMembership} is the single function that turns an authenticated `userId` plus
 * an `orgId` into a role, and `requireOrgMember` trusts its answer completely. Every commerce
 * repository beneath it scopes on `org_id` alone and assumes that check already happened. There is
 * no other entrance to a tenant's data.
 */
class OrganizationRepository {
  /**
   * Create an organization and make its creator the `owner`, in ONE transaction. An org that exists
   * without an owner has nobody who can pay for it, invite into it, or delete it — and no path back
   * to having one. The two writes must not be separable.
   *
   * Slug collisions are resolved here rather than reported: the caller's preferred handle is tried
   * first, then suffixed. Retrying on a taken slug is the caller's problem we are removing.
   */
  async create(params: {
    name: string;
    slug: string;
    createdBy: string;
  }): Promise<{ org: Organization; role: OrgRole }> {
    return db.transaction().execute(async (trx) => {
      let slug = params.slug;
      for (let attempt = 0; ; attempt += 1) {
        const taken = await trx
          .selectFrom('organizations')
          .select('id')
          .where('slug', '=', slug)
          .executeTakeFirst();
        if (taken === undefined) break;
        // Random rather than sequential: a sequential probe leaks how many orgs share a name, and
        // two concurrent signups would race to the same next number.
        slug = `${params.slug}-${randomBytes(3).toString('hex')}`;
        // Belt and braces — 4 random hex collisions in a row means something is very wrong.
        if (attempt > 8) throw new Error('could not allocate a unique organization slug');
      }

      const orgRow = await trx
        .insertInto('organizations')
        .values({ name: params.name, slug, created_by: params.createdBy })
        .returningAll()
        .executeTakeFirstOrThrow();

      await trx
        .insertInto('org_members')
        .values({ org_id: orgRow.id, user_id: params.createdBy, role: 'owner' })
        .execute();

      return { org: toOrg(orgRow), role: 'owner' as const };
    });
  }

  /**
   * The caller's role in `orgId`, or null when they are not a member.
   *
   * Returning null rather than throwing is deliberate: "not a member" and "no such org" must be
   * indistinguishable to the caller, so probing ids cannot enumerate which organizations exist.
   * `requireOrgMember` renders both as the same 404.
   */
  async findMembership(userId: string, orgId: string): Promise<OrgMembership | null> {
    const row = await db
      .selectFrom('org_members')
      .innerJoin('organizations', 'organizations.id', 'org_members.org_id')
      .select([
        'org_members.role as role',
        'organizations.id as id',
        'organizations.name as name',
        'organizations.slug as slug',
        'organizations.status as status',
        'organizations.created_at as created_at',
      ])
      .where('org_members.user_id', '=', userId)
      .where('org_members.org_id', '=', orgId)
      .executeTakeFirst();

    if (row === undefined) return null;
    return {
      org: {
        id: row.id,
        name: row.name,
        slug: row.slug,
        status: row.status,
        createdAt: row.created_at.toISOString(),
      },
      role: row.role,
    };
  }

  /** Every organization the user belongs to, newest first. */
  async listForUser(userId: string): Promise<OrgMembership[]> {
    const rows = await db
      .selectFrom('org_members')
      .innerJoin('organizations', 'organizations.id', 'org_members.org_id')
      .select([
        'org_members.role as role',
        'organizations.id as id',
        'organizations.name as name',
        'organizations.slug as slug',
        'organizations.status as status',
        'organizations.created_at as created_at',
      ])
      .where('org_members.user_id', '=', userId)
      .orderBy('organizations.created_at', 'desc')
      .execute();

    return rows.map((row) => ({
      org: {
        id: row.id,
        name: row.name,
        slug: row.slug,
        status: row.status,
        createdAt: row.created_at.toISOString(),
      },
      role: row.role,
    }));
  }

  /** The org's members, with the display fields a member list needs, so listing is one query. */
  async listMembers(orgId: string): Promise<OrgMember[]> {
    const rows = await db
      .selectFrom('org_members')
      .innerJoin('users', 'users.id', 'org_members.user_id')
      .select([
        'org_members.id as id',
        'org_members.org_id as org_id',
        'org_members.user_id as user_id',
        'org_members.role as role',
        'org_members.created_at as created_at',
        'users.display_name as display_name',
        'users.email as email',
      ])
      .where('org_members.org_id', '=', orgId)
      .orderBy('org_members.created_at', 'asc')
      .execute();

    return rows.map((row) => ({
      id: row.id,
      orgId: row.org_id,
      userId: row.user_id,
      role: row.role,
      displayName: row.display_name,
      email: row.email,
      createdAt: row.created_at.toISOString(),
    }));
  }

  /** How many owners the org has. Used to refuse removing or demoting the last one. */
  async countOwners(orgId: string): Promise<number> {
    const row = await db
      .selectFrom('org_members')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('org_id', '=', orgId)
      .where('role', '=', 'owner')
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  async findMemberById(orgId: string, memberId: string): Promise<Selectable<OrgMembersTable> | null> {
    const row = await db
      .selectFrom('org_members')
      .selectAll()
      .where('org_id', '=', orgId)
      .where('id', '=', memberId)
      .executeTakeFirst();
    return row ?? null;
  }

  async updateMemberRole(orgId: string, memberId: string, role: OrgRole): Promise<void> {
    await db
      .updateTable('org_members')
      .set({ role })
      .where('org_id', '=', orgId)
      .where('id', '=', memberId)
      .execute();
  }

  async removeMember(orgId: string, memberId: string): Promise<void> {
    await db
      .deleteFrom('org_members')
      .where('org_id', '=', orgId)
      .where('id', '=', memberId)
      .execute();
  }

  /**
   * Mint an invite. The plaintext token is returned to the caller and NEVER stored — only its
   * SHA-256 is. This invite grants access to a business's entire customer list, so it is treated
   * exactly like a device token.
   */
  async createInvite(params: {
    orgId: string;
    email: string;
    role: OrgRole;
    invitedBy: string;
    expiresAt: Date;
  }): Promise<{ invite: OrgInvite; token: string }> {
    const token = generateInviteToken();
    const row = await db
      .insertInto('org_invites')
      .values({
        org_id: params.orgId,
        email: params.email.trim().toLowerCase(),
        role: params.role,
        token_hash: hashToken(token),
        invited_by: params.invitedBy,
        expires_at: params.expiresAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { invite: toInvite(row), token };
  }

  async listInvites(orgId: string): Promise<OrgInvite[]> {
    const rows = await db
      .selectFrom('org_invites')
      .selectAll()
      .where('org_id', '=', orgId)
      .where('status', '=', 'pending')
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map(toInvite);
  }

  /**
   * Redeem an invite: mark it accepted and add the membership, in ONE transaction.
   *
   * The UPDATE's WHERE clause is the atomic guard — it matches only a `pending`, unexpired row
   * addressed to this user's own email, so two concurrent redemptions of the same token cannot both
   * succeed and a forwarded link cannot be redeemed by whoever received it. Returns null when the
   * token is unknown, already used, expired, or addressed to someone else; the caller renders all
   * four identically so a probe learns nothing about which case it hit.
   *
   * The email is matched inside the same statement rather than checked first, so a mismatch never
   * burns the invite — the row simply does not match and stays `pending` for its real recipient.
   */
  async acceptInvite(
    token: string,
    userId: string,
  ): Promise<{ org: Organization; role: OrgRole } | null> {
    return db.transaction().execute(async (trx) => {
      const user = await trx
        .selectFrom('users')
        .select('email')
        .where('id', '=', userId)
        .executeTakeFirstOrThrow();

      const invite = await trx
        .updateTable('org_invites')
        .set({ status: 'accepted', accepted_at: new Date() })
        .where('token_hash', '=', hashToken(token))
        .where('status', '=', 'pending')
        .where('expires_at', '>', new Date())
        .where('email', '=', user.email.trim().toLowerCase())
        .returningAll()
        .executeTakeFirst();
      if (invite === undefined) return null;

      // Already a member (invited twice, or invited after joining): keep the role they already have
      // rather than silently changing it. An invite must never DEMOTE someone.
      const existing = await trx
        .selectFrom('org_members')
        .select('role')
        .where('org_id', '=', invite.org_id)
        .where('user_id', '=', userId)
        .executeTakeFirst();
      if (existing === undefined) {
        await trx
          .insertInto('org_members')
          .values({ org_id: invite.org_id, user_id: userId, role: invite.role })
          .execute();
      }

      const orgRow = await trx
        .selectFrom('organizations')
        .selectAll()
        .where('id', '=', invite.org_id)
        .executeTakeFirstOrThrow();

      return { org: toOrg(orgRow), role: existing?.role ?? invite.role };
    });
  }

  /**
   * The org this user's conversational turns act on, or null when they have not chosen one.
   *
   * Null is an honest answer here, not a substituted one: the command layer must ASK which business
   * the user means rather than pick their first membership, because picking wrong sends a stranger's
   * customers a campaign. There is deliberately no fallback.
   */
  async findActiveOrgId(userId: string): Promise<string | null> {
    const row = await db
      .selectFrom('commerce_active_orgs')
      .select('org_id')
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row?.org_id ?? null;
  }

  /**
   * Record which org the user is acting on. The caller must have already verified membership —
   * this writes what it is told, and an unchecked orgId here would hand the conversational surface a
   * tenant the user does not belong to.
   */
  async setActiveOrgId(userId: string, orgId: string): Promise<void> {
    await db
      .insertInto('commerce_active_orgs')
      .values({ user_id: userId, org_id: orgId })
      .onConflict((oc) => oc.column('user_id').doUpdateSet({ org_id: orgId, updated_at: new Date() }))
      .execute();
  }

  /** Revoke a pending invite. Returns false when there was no pending invite to revoke. */
  async revokeInvite(orgId: string, inviteId: string): Promise<boolean> {
    const result = await db
      .updateTable('org_invites')
      .set({ status: 'revoked' })
      .where('org_id', '=', orgId)
      .where('id', '=', inviteId)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }
}

export const organizationRepository = new OrganizationRepository();
