import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { config } from '../config/unifiedConfig.js';
import { db, closeDb } from '../database/index.js';
import { errorHandler } from '../middleware/errorHandler.js';
import orgRoutes from '../commerce/routes/organizations.js';
import rateCardRoutes from '../commerce/routes/rateCards.js';
import spendCapRoutes from '../commerce/routes/spendCaps.js';
import billingRoutes from '../commerce/routes/billing.js';
import { organizationRepository } from '../commerce/repositories/organizationRepository.js';
import { invoiceRepository } from '../commerce/repositories/invoiceRepository.js';
import { orgInviteEmailRegistry } from '../ports/orgInviteEmail.js';

// Creating an invite now delivers its link through the orgInviteEmail port, and this file builds the
// router directly rather than through `createApp()`, so no transport is wired. This suite is about
// tenancy, not delivery — a sink keeps the invite tests running; delivery itself is what
// commerceOrgInvites.test.ts covers.
orgInviteEmailRegistry.register({ send: async () => {} });

/**
 * TENANCY. The commerce plane is multi-tenant, so the question this suite exists to answer is the
 * only one that really matters about it: can a member of one organization reach another's data?
 *
 * Nothing here is stood in for. The real router, the real `requireAuth` → `requireEmailVerification`
 * → `requireOrgMember` chain, the real `stewra_test` Postgres, real HTTP with real bearer tokens.
 * Calling the controller directly would skip the middleware, and the middleware IS the boundary — a
 * test that asserts a service function filters by org_id proves nothing about the door being shut.
 *
 * The assertions are on status codes a real caller would receive, including the deliberate
 * 404-not-403 for a non-member: a 403 confirms the org id exists, which turns an id that appears in
 * invite links and shared URLs into an enumeration oracle.
 */

const app = express();
app.use(express.json());
app.use('/orgs', orgRoutes);
// The platform-operator surfaces, mounted exactly as app.ts mounts them — this suite proves an
// org role, owner included, does not exist to them.
app.use('/platform/rate-cards', rateCardRoutes);
app.use('/platform/spend-caps', spendCapRoutes);
app.use('/platform/billing', billingRoutes);
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const API = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const PASSWORD_HASH = await bcrypt.hash(randomUUID(), 10);
const createdUsers: string[] = [];
const createdOrgs: string[] = [];

interface TestUser {
  readonly id: string;
  readonly email: string;
  readonly auth: string;
}

async function createUser(opts: { verified?: boolean } = {}): Promise<TestUser> {
  const email = `commerce-tenancy-${randomUUID()}@stewra.invalid`;
  const row = await db
    .insertInto('users')
    .values({
      email,
      display_name: 'Commerce Tenancy Test User',
      password_hash: PASSWORD_HASH,
      role: 'user',
      email_verified: opts.verified ?? true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  createdUsers.push(row.id);
  // A real access token, signed the way authService signs one — so requireAuth verifies it for real.
  const auth = `Bearer ${jwt.sign({ sub: row.id, type: 'access' }, config.auth.jwtSecret, {
    expiresIn: 3600,
  })}`;
  return { id: row.id, email, auth };
}

/** An organization owned by a freshly created user. */
async function createOrg(name = 'Acme Coffee'): Promise<{ owner: TestUser; orgId: string }> {
  const owner = await createUser();
  const { org } = await organizationRepository.create({
    name,
    slug: `acme-${randomUUID().slice(0, 8)}`,
    createdBy: owner.id,
  });
  createdOrgs.push(org.id);
  return { owner, orgId: org.id };
}

/** Put an existing user into an org at a given role, bypassing the invite dance. */
async function addMember(orgId: string, role: string): Promise<TestUser> {
  const user = await createUser();
  await db
    .insertInto('org_members')
    .values({ org_id: orgId, user_id: user.id, role: role as 'admin' })
    .execute();
  return user;
}

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (createdOrgs.length > 0) {
    // This suite only ever writes DRAFT invoices, which the immutability trigger lets go freely.
    await db
      .deleteFrom('commerce_invoice_lines')
      .where(
        'invoice_id',
        'in',
        db.selectFrom('commerce_invoices').select('id').where('org_id', 'in', createdOrgs),
      )
      .execute();
    await db.deleteFrom('commerce_invoices').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_billing_periods').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('commerce_active_orgs').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('org_invites').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('org_members').where('org_id', 'in', createdOrgs).execute();
    // Before the users: organizations.created_by is ON DELETE RESTRICT on purpose.
    await db.deleteFrom('organizations').where('id', 'in', createdOrgs).execute();
  }
  if (createdUsers.length > 0) {
    await db
      .deleteFrom('users')
      .where('id', 'in', createdUsers)
      .where(({ not, exists, selectFrom }) =>
        not(exists(selectFrom('audit_log').select('id').whereRef('audit_log.user_id', '=', 'users.id'))),
      )
      .execute();
  }
  await closeDb();
});

// ---------------------------------------------------------------------------------------------
// The boundary between tenants
// ---------------------------------------------------------------------------------------------

describe('one organization cannot be reached from another', () => {
  it("answers a non-member with 404, not 403 — an org id must not be confirmable", async () => {
    const { orgId } = await createOrg();
    const outsider = await createUser();

    const get = await request(API).get(`/orgs/${orgId}`).set('Authorization', outsider.auth);
    expect(get.status).toBe(404);

    const members = await request(API)
      .get(`/orgs/${orgId}/members`)
      .set('Authorization', outsider.auth);
    expect(members.status).toBe(404);

    // The same answer a genuinely nonexistent org gives. If these two ever diverge, the id becomes
    // an oracle for "which organizations exist".
    const ghost = await request(API)
      .get(`/orgs/${randomUUID()}`)
      .set('Authorization', outsider.auth);
    expect(ghost.status).toBe(404);
    expect(get.body).toEqual(ghost.body);
  });

  it('does not let a member of one org list another org, even as its own owner', async () => {
    const a = await createOrg('Org A');
    const b = await createOrg('Org B');

    const crossing = await request(API).get(`/orgs/${b.orgId}/members`).set('Authorization', a.owner.auth);
    expect(crossing.status).toBe(404);

    // And their own org still works — proving the 404 above is the boundary, not a broken route.
    const own = await request(API).get(`/orgs/${a.orgId}/members`).set('Authorization', a.owner.auth);
    expect(own.status).toBe(200);
    expect(own.body.data.members).toHaveLength(1);
  });

  it('refuses to make a stranger org the active one, and writes nothing', async () => {
    const { orgId } = await createOrg();
    const outsider = await createUser();

    const res = await request(API)
      .put('/orgs/active')
      .set('Authorization', outsider.auth)
      .send({ orgId });
    expect(res.status).toBe(404);

    // The conversational surface reads this row to resolve a tenant with no route param to check.
    // A write here would hand an outsider a whole business.
    expect(await organizationRepository.findActiveOrgId(outsider.id)).toBeNull();
  });

  it('refuses everything for a suspended organization, including its owner', async () => {
    const { owner, orgId } = await createOrg();
    await db.updateTable('organizations').set({ status: 'suspended' }).where('id', '=', orgId).execute();

    const res = await request(API).get(`/orgs/${orgId}`).set('Authorization', owner.auth);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ORGANIZATION_SUSPENDED');
  });

  it('turns away an unauthenticated or unverified caller before any org lookup happens', async () => {
    const { orgId } = await createOrg();
    const unverified = await createUser({ verified: false });

    expect((await request(API).get(`/orgs/${orgId}`)).status).toBe(401);

    const res = await request(API).get(`/orgs/${orgId}`).set('Authorization', unverified.auth);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('EMAIL_NOT_VERIFIED');
  });
});

// ---------------------------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------------------------

describe('roles inside an organization', () => {
  it('lets a viewer read but not invite', async () => {
    const { orgId } = await createOrg();
    const viewer = await addMember(orgId, 'viewer');

    const read = await request(API).get(`/orgs/${orgId}/members`).set('Authorization', viewer.auth);
    expect(read.status).toBe(200);
    // A pending invite exposes the email of someone who has not joined — not a viewer's business.
    expect(read.body.data.invites).toEqual([]);

    const invite = await request(API)
      .post(`/orgs/${orgId}/invites`)
      .set('Authorization', viewer.auth)
      .send({ email: 'someone@stewra.invalid', role: 'agent' });
    expect(invite.status).toBe(403);
    expect(invite.body.error.code).toBe('INSUFFICIENT_ORG_ROLE');
  });

  it('stops an admin from minting an owner — the self-promotion path', async () => {
    const { orgId } = await createOrg();
    const admin = await addMember(orgId, 'admin');

    const res = await request(API)
      .post(`/orgs/${orgId}/invites`)
      .set('Authorization', admin.auth)
      .send({ email: `new-owner-${randomUUID()}@stewra.invalid`, role: 'owner' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('OWNER_ROLE_REQUIRED');
  });

  it('stops an admin from demoting or removing an owner', async () => {
    const { owner, orgId } = await createOrg();
    const admin = await addMember(orgId, 'admin');
    const ownerMemberId = (await organizationRepository.listMembers(orgId)).find(
      (m) => m.userId === owner.id,
    )?.id;
    expect(ownerMemberId).toBeDefined();

    const demote = await request(API)
      .patch(`/orgs/${orgId}/members/${ownerMemberId ?? ''}`)
      .set('Authorization', admin.auth)
      .send({ role: 'viewer' });
    expect(demote.status).toBe(403);

    const remove = await request(API)
      .delete(`/orgs/${orgId}/members/${ownerMemberId ?? ''}`)
      .set('Authorization', admin.auth);
    expect(remove.status).toBe(403);
  });

  it('refuses to leave an organization with no owner at all', async () => {
    const { owner, orgId } = await createOrg();
    const ownerMemberId = (await organizationRepository.listMembers(orgId)).find(
      (m) => m.userId === owner.id,
    )?.id;

    const res = await request(API)
      .patch(`/orgs/${orgId}/members/${ownerMemberId ?? ''}`)
      .set('Authorization', owner.auth)
      .send({ role: 'admin' });
    expect(res.status).toBe(409);
    expect(await organizationRepository.countOwners(orgId)).toBe(1);
  });

  it('allows the handover once a second owner exists', async () => {
    const { owner, orgId } = await createOrg();
    const successor = await addMember(orgId, 'owner');
    const ownerMemberId = (await organizationRepository.listMembers(orgId)).find(
      (m) => m.userId === owner.id,
    )?.id;
    expect(successor.id).toBeDefined();

    const res = await request(API)
      .patch(`/orgs/${orgId}/members/${ownerMemberId ?? ''}`)
      .set('Authorization', owner.auth)
      .send({ role: 'admin' });
    expect(res.status).toBe(200);
    expect(res.body.data.member.role).toBe('admin');
    expect(await organizationRepository.countOwners(orgId)).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Invites — the only way into a tenant
// ---------------------------------------------------------------------------------------------

describe('invites', () => {
  async function mintInvite(
    orgId: string,
    owner: TestUser,
    email: string,
    role = 'agent',
  ): Promise<string> {
    const res = await request(API)
      .post(`/orgs/${orgId}/invites`)
      .set('Authorization', owner.auth)
      .send({ email, role });
    expect(res.status).toBe(201);
    return res.body.data.token as string;
  }

  it('admits the invited person and nobody else', async () => {
    const { owner, orgId } = await createOrg();
    const invitee = await createUser();
    const token = await mintInvite(orgId, owner, invitee.email);

    const accepted = await request(API)
      .post('/orgs/invites/accept')
      .set('Authorization', invitee.auth)
      .send({ token });
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.role).toBe('agent');
    expect(accepted.body.data.org.id).toBe(orgId);
  });

  it('refuses a forwarded link, and leaves the invite redeemable by its real recipient', async () => {
    const { owner, orgId } = await createOrg();
    const invitee = await createUser();
    const forwardedTo = await createUser();
    const token = await mintInvite(orgId, owner, invitee.email);

    const stolen = await request(API)
      .post('/orgs/invites/accept')
      .set('Authorization', forwardedTo.auth)
      .send({ token });
    expect(stolen.status).toBe(404);
    expect(await organizationRepository.findMembership(forwardedTo.id, orgId)).toBeNull();

    // The mismatch must not have burned the invite — the person it was addressed to still gets in.
    const real = await request(API)
      .post('/orgs/invites/accept')
      .set('Authorization', invitee.auth)
      .send({ token });
    expect(real.status).toBe(200);
  });

  it('cannot be redeemed twice', async () => {
    const { owner, orgId } = await createOrg();
    const invitee = await createUser();
    const token = await mintInvite(orgId, owner, invitee.email);

    expect(
      (await request(API).post('/orgs/invites/accept').set('Authorization', invitee.auth).send({ token }))
        .status,
    ).toBe(200);
    expect(
      (await request(API).post('/orgs/invites/accept').set('Authorization', invitee.auth).send({ token }))
        .status,
    ).toBe(404);
  });

  it('cannot be redeemed after it is revoked', async () => {
    const { owner, orgId } = await createOrg();
    const invitee = await createUser();
    const token = await mintInvite(orgId, owner, invitee.email);

    const invites = await request(API).get(`/orgs/${orgId}/members`).set('Authorization', owner.auth);
    const inviteId = invites.body.data.invites[0].id as string;

    expect(
      (await request(API).delete(`/orgs/${orgId}/invites/${inviteId}`).set('Authorization', owner.auth))
        .status,
    ).toBe(200);
    expect(
      (await request(API).post('/orgs/invites/accept').set('Authorization', invitee.auth).send({ token }))
        .status,
    ).toBe(404);
    expect(await organizationRepository.findMembership(invitee.id, orgId)).toBeNull();
  });

  it('never demotes someone who is already a member', async () => {
    const { owner, orgId } = await createOrg();
    const admin = await addMember(orgId, 'admin');
    const token = await mintInvite(orgId, owner, admin.email, 'viewer');

    const res = await request(API)
      .post('/orgs/invites/accept')
      .set('Authorization', admin.auth)
      .send({ token });
    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('admin');
    expect((await organizationRepository.findMembership(admin.id, orgId))?.role).toBe('admin');
  });

  it('stores the token hashed — a database read must not yield a usable invite', async () => {
    const { owner, orgId } = await createOrg();
    const invitee = await createUser();
    const token = await mintInvite(orgId, owner, invitee.email);

    const row = await db
      .selectFrom('org_invites')
      .select('token_hash')
      .where('org_id', '=', orgId)
      .executeTakeFirstOrThrow();
    expect(row.token_hash).not.toContain(token);
    expect(row.token_hash).toHaveLength(64);
  });
});

// ---------------------------------------------------------------------------------------------
// Money: the billing documents and the platform-operator surfaces
// ---------------------------------------------------------------------------------------------

describe('billing stays inside the tenant, and pricing stays outside every tenant', () => {
  /** A draft invoice for the org — enough document to point a cross-tenant read at. */
  async function draftInvoice(orgId: string): Promise<string> {
    const now = new Date();
    const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
      .toISOString()
      .slice(0, 10);
    const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      .toISOString()
      .slice(0, 10);
    const invoice = await invoiceRepository.writeCloseOutcome({
      orgId,
      currency: 'ZZZ',
      periodStart,
      periodEnd,
      lines: [
        { kind: 'message_costs', description: 'tenancy fixture', quantity: 1, amountMicros: 1_000n },
      ],
      unratedBillable: 1, // keeps it a draft, which keeps the cleanup trigger-free
      unpricedMessages: 0,
      issue: false,
    });
    return invoice.id;
  }

  it("keeps one org's invoices, costs, spend and plan unreadable from another", async () => {
    const a = await createOrg('Org A Money');
    const b = await createOrg('Org B Money');
    const invoiceId = await draftInvoice(a.orgId);

    // The owner reads their own documents…
    const own = await request(API)
      .get(`/orgs/${a.orgId}/invoices/${invoiceId}`)
      .set('Authorization', a.owner.auth);
    expect(own.status).toBe(200);

    // …and a neighboring org's owner reads none of it, with the same non-oracle 404.
    for (const path of [
      `/orgs/${a.orgId}/invoices`,
      `/orgs/${a.orgId}/invoices/${invoiceId}`,
      `/orgs/${a.orgId}/billing`,
      `/orgs/${a.orgId}/spend`,
      `/orgs/${a.orgId}/costs?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z`,
    ]) {
      const res = await request(API).get(path).set('Authorization', b.owner.auth);
      expect(res.status, path).toBe(404);
    }
  });

  it('holds the billing reads to admin, except the spend explanation', async () => {
    const { orgId } = await createOrg('Roles And Money');
    const viewer = await addMember(orgId, 'viewer');

    // What the org is billed is the admin's business…
    for (const path of [
      `/orgs/${orgId}/invoices`,
      `/orgs/${orgId}/billing`,
      `/orgs/${orgId}/costs?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z`,
    ]) {
      const res = await request(API).get(path).set('Authorization', viewer.auth);
      expect(res.status, path).toBe(403);
      expect(res.body.error.code).toBe('INSUFFICIENT_ORG_ROLE');
    }
    // …but the person watching a campaign the cap paused deserves the explanation.
    const spend = await request(API).get(`/orgs/${orgId}/spend`).set('Authorization', viewer.auth);
    expect(spend.status).toBe(200);
  });

  it('answers every platform-operator surface with 404 for org roles, owner included', async () => {
    const { owner, orgId } = await createOrg('Would-Be Self-Pricer');
    const admin = await addMember(orgId, 'admin');
    const invoiceId = await draftInvoice(orgId);

    const calls: Array<{ method: 'get' | 'put' | 'post'; path: string; body?: object }> = [
      { method: 'get', path: '/platform/rate-cards' },
      { method: 'get', path: '/platform/spend-caps?orgId=' + orgId },
      {
        method: 'put',
        path: '/platform/spend-caps',
        body: { orgId, currency: 'USD', limitMicros: '999999999', note: 'self-serve' },
      },
      { method: 'get', path: '/platform/billing/plans' },
      {
        method: 'put',
        path: '/platform/billing/plans',
        body: { name: 'Free For Me', platformFeeMicros: '0', currency: 'USD', note: 'self-serve' },
      },
      {
        method: 'put',
        path: '/platform/billing/subscriptions',
        body: { orgId, planId: null, note: 'self-serve' },
      },
      { method: 'post', path: `/platform/billing/invoices/${invoiceId}/mark-paid`, body: { note: 'paid myself' } },
      { method: 'post', path: `/platform/billing/invoices/${invoiceId}/charge`, body: {} },
    ];
    for (const user of [owner, admin]) {
      for (const call of calls) {
        const res = await request(API)
          [call.method](call.path)
          .set('Authorization', user.auth)
          .send(call.body ?? {});
        // 404, not 403: to an org role these surfaces must not exist, or the response itself
        // confirms there is a pricing panel worth attacking.
        expect(res.status, `${call.method} ${call.path}`).toBe(404);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Creation and the active-org selection
// ---------------------------------------------------------------------------------------------

describe('creating an organization', () => {
  it('makes the creator its owner in the same breath', async () => {
    const user = await createUser();
    const res = await request(API)
      .post('/orgs')
      .set('Authorization', user.auth)
      .send({ name: 'Bright Dental' });
    expect(res.status).toBe(201);
    createdOrgs.push(res.body.data.org.id as string);

    expect(res.body.data.role).toBe('owner');
    // An org that exists without an owner has nobody who can pay for it and no path back to having one.
    expect(await organizationRepository.countOwners(res.body.data.org.id as string)).toBe(1);
  });

  it('resolves a slug collision instead of rejecting the signup', async () => {
    const first = await createUser();
    const second = await createUser();
    const slug = `collide-${randomUUID().slice(0, 8)}`;

    const a = await request(API).post('/orgs').set('Authorization', first.auth).send({ name: 'X', slug });
    const b = await request(API).post('/orgs').set('Authorization', second.auth).send({ name: 'X', slug });
    createdOrgs.push(a.body.data.org.id as string, b.body.data.org.id as string);

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.data.org.slug).toBe(slug);
    expect(b.body.data.org.slug).not.toBe(slug);
  });

  it('reports the active org as null until one is chosen — never a guess', async () => {
    const { owner, orgId } = await createOrg();

    const before = await request(API).get('/orgs').set('Authorization', owner.auth);
    expect(before.status).toBe(200);
    expect(before.body.data.memberships).toHaveLength(1);
    // Defaulting to "their only org" is exactly the guess that sends a stranger's customers a campaign
    // once they belong to two. The command layer asks instead.
    expect(before.body.data.activeOrgId).toBeNull();

    expect(
      (await request(API).put('/orgs/active').set('Authorization', owner.auth).send({ orgId })).status,
    ).toBe(200);

    const after = await request(API).get('/orgs').set('Authorization', owner.auth);
    expect(after.body.data.activeOrgId).toBe(orgId);
  });
});
