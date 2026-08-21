import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { config } from '../config/unifiedConfig.js';
import { db, closeDb } from '../database/index.js';
import { errorHandler } from '../middleware/errorHandler.js';
import orgRoutes from '../tenancy/routes/organizations.js';
import commerceOrgRoutes from '../commerce/routes/orgSurface.js';
import { organizationRepository } from '../tenancy/repositories/organizationRepository.js';
import { orgInviteEmailRegistry } from '../ports/orgInviteEmail.js';
import type { OrgInviteEmail } from '../ports/orgInviteEmail.js';

/**
 * DELIVERY. commerceTenancy.test.ts proves who an invite admits; this suite proves the invite
 * actually REACHES someone — the gap that made the whole role model unusable (a token returned once
 * to the admin, and no way to hand it over).
 *
 * The port is the seam: a scripted `OrgInviteEmailSender` stands where SMTP would, so what lands in
 * the "inbox" is exactly what `organizationService` sends through `ports/orgInviteEmail`. Everything
 * else is real — the router, the middleware chain, the `stewra_test` Postgres.
 */

const app = express();
app.use(express.json());
app.use('/orgs', orgRoutes);
app.use('/orgs/:orgId', commerceOrgRoutes);
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const API = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const PASSWORD_HASH = await bcrypt.hash(randomUUID(), 10);
const createdUsers: string[] = [];
const createdOrgs: string[] = [];

/** What the scripted sender "delivered" since the last reset. */
const inbox: OrgInviteEmail[] = [];

beforeEach(() => {
  inbox.length = 0;
  orgInviteEmailRegistry.register({
    send: async (email) => {
      inbox.push(email);
    },
  });
});

interface TestUser {
  readonly id: string;
  readonly email: string;
  readonly auth: string;
}

async function createUser(displayName = 'Invite Test User'): Promise<TestUser> {
  const email = `commerce-invites-${randomUUID()}@stewra.invalid`;
  const row = await db
    .insertInto('users')
    .values({
      email,
      display_name: displayName,
      password_hash: PASSWORD_HASH,
      role: 'user',
      email_verified: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  createdUsers.push(row.id);
  const auth = `Bearer ${jwt.sign({ sub: row.id, type: 'access' }, config.auth.jwtSecret, {
    expiresIn: 3600,
  })}`;
  return { id: row.id, email, auth };
}

async function createOrg(name = 'Bluebird Bakery'): Promise<{ owner: TestUser; orgId: string }> {
  const owner = await createUser('Odette Owner');
  const { org } = await organizationRepository.create({
    kind: 'business',
    name,
    slug: `bluebird-${randomUUID().slice(0, 8)}`,
    createdBy: owner.id,
  });
  createdOrgs.push(org.id);
  return { owner, orgId: org.id };
}

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (createdOrgs.length > 0) {
    await db.deleteFrom('org_invites').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('org_members').where('org_id', 'in', createdOrgs).execute();
    // Before the users: organizations.created_by is ON DELETE RESTRICT on purpose.
    await db.deleteFrom('organizations').where('id', 'in', createdOrgs).execute();
  }
  if (createdUsers.length > 0) {
    await db.deleteFrom('users').where('id', 'in', createdUsers).execute();
  }
  await closeDb();
});

describe('creating an invite delivers it', () => {
  it('emails the invitee a link that carries the token, named for the org and the inviter', async () => {
    const { owner, orgId } = await createOrg('Bluebird Bakery');
    const invitee = await createUser();

    const res = await request(API)
      .post(`/orgs/${orgId}/invites`)
      .set('Authorization', owner.auth)
      .send({ email: invitee.email, role: 'marketer' });
    expect(res.status).toBe(201);
    const token = res.body.data.token as string;

    expect(inbox).toHaveLength(1);
    const email = inbox[0];
    if (email === undefined) throw new Error('no invite email was delivered');
    expect(email.to).toBe(invitee.email);
    expect(email.orgName).toBe('Bluebird Bakery');
    expect(email.inviterName).toBe('Odette Owner');
    expect(email.role).toBe('marketer');
    expect(email.acceptUrl).toBe(
      `${config.web.appUrl}/invites/accept?token=${encodeURIComponent(token)}`,
    );
    // Roughly the seven-day TTL — pinned loosely so a slow test run cannot flake it.
    const ttlMs = email.expiresAt.getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);
    expect(ttlMs).toBeLessThan(7.1 * 24 * 60 * 60 * 1000);
  });

  it('the emailed link is the whole loop — its token redeems the invite', async () => {
    const { owner, orgId } = await createOrg();
    const invitee = await createUser();

    await request(API)
      .post(`/orgs/${orgId}/invites`)
      .set('Authorization', owner.auth)
      .send({ email: invitee.email, role: 'agent' });

    // Read the token the way the invitee would: out of the emailed URL, not the API response.
    const delivered = inbox[0];
    if (delivered === undefined) throw new Error('no invite email was delivered');
    const url = new URL(delivered.acceptUrl);
    expect(url.pathname).toBe('/invites/accept');
    const token = url.searchParams.get('token');
    expect(token).not.toBeNull();

    const accepted = await request(API)
      .post('/orgs/invites/accept')
      .set('Authorization', invitee.auth)
      .send({ token });
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.org.id).toBe(orgId);
    expect((await organizationRepository.findMembership(invitee.id, orgId))?.role).toBe('agent');
  });
});

describe('when the email cannot be sent', () => {
  it('reports the failure and leaves no pending invite behind', async () => {
    const { owner, orgId } = await createOrg();
    orgInviteEmailRegistry.register({
      send: async () => {
        throw new Error('SMTP said no');
      },
    });

    const res = await request(API)
      .post(`/orgs/${orgId}/invites`)
      .set('Authorization', owner.auth)
      .send({ email: `nobody-${randomUUID()}@stewra.invalid`, role: 'agent' });
    expect(res.status).toBe(500);

    // The failed invite must not linger as `pending` — the admin's retry mints a fresh one, and a
    // zombie row is indistinguishable from "the invitee is ignoring me".
    const invites = await request(API).get(`/orgs/${orgId}/members`).set('Authorization', owner.auth);
    expect(invites.body.data.invites).toEqual([]);
  });

  it('a process with no mail transport wired refuses to mint invites at all', async () => {
    const { owner, orgId } = await createOrg();
    orgInviteEmailRegistry.reset();

    const res = await request(API)
      .post(`/orgs/${orgId}/invites`)
      .set('Authorization', owner.auth)
      .send({ email: `nobody-${randomUUID()}@stewra.invalid`, role: 'agent' });
    expect(res.status).toBe(500);

    const invites = await request(API).get(`/orgs/${orgId}/members`).set('Authorization', owner.auth);
    expect(invites.body.data.invites).toEqual([]);
  });
});
