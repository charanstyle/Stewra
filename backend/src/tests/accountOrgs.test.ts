import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { db, closeDb } from '../database/index.js';
import { createApp } from '../app.js';
import { orgInviteEmailRegistry } from '../ports/orgInviteEmail.js';

/**
 * Every account is a tenant (migration 063).
 *
 * Driven through the HTTP surface, because the rules under test are the ones a client would trip:
 * signup creates the org in the same transaction; the kind is stated, never inferred; an individual
 * org refuses invites until it is explicitly converted; and conversion is owner-only and one-way.
 * Real Postgres, because the invite refusal is ALSO a trigger, and the trigger is what stops any
 * future code path — not just the one this service exposes — from quietly turning a person into a
 * team.
 */

const app = createApp();
const createdEmails: string[] = [];

interface SignUpBody {
  readonly email: string;
  readonly password: string;
  readonly displayName: string;
  readonly accountKind?: string;
  readonly companyName?: string;
}

async function signUp(body: SignUpBody): Promise<request.Response> {
  createdEmails.push(body.email);
  return request(app).post('/auth/register').send(body);
}

async function verifiedSignUp(kind: 'individual' | 'business'): Promise<{
  token: string;
  userId: string;
  orgId: string;
}> {
  const email = `orgs-${kind}-${randomUUID()}@stewra.invalid`;
  const res = await signUp({
    email,
    password: `Pw!${randomUUID()}`,
    displayName: 'Tenancy Test',
    accountKind: kind,
    ...(kind === 'business' ? { companyName: 'Tenancy Test Ltd' } : {}),
  });
  expect(res.status).toBe(201);
  const userId: string = res.body.data.user.id;
  // The org routes sit behind email verification; flip the flag the way the verify flow would.
  await db.updateTable('users').set({ email_verified: true }).where('id', '=', userId).execute();
  const orgs = await request(app)
    .get('/orgs')
    .set('Authorization', `Bearer ${res.body.data.tokens.accessToken}`);
  expect(orgs.status).toBe(200);
  expect(orgs.body.data.memberships).toHaveLength(1);
  return {
    token: res.body.data.tokens.accessToken,
    userId,
    orgId: orgs.body.data.memberships[0].org.id,
  };
}

beforeAll(() => {
  orgInviteEmailRegistry.register({ send: async () => {} });
});

afterAll(async () => {
  for (const email of createdEmails) {
    await db.deleteFrom('users').where('email', '=', email).execute();
  }
  await closeDb();
});

describe('signup creates the tenant', () => {
  it('gives an individual an org named after them, with kind individual and role owner', async () => {
    const { token } = await verifiedSignUp('individual');
    const res = await request(app).get('/orgs').set('Authorization', `Bearer ${token}`);
    const [membership] = res.body.data.memberships;
    expect(membership.org.kind).toBe('individual');
    expect(membership.org.name).toBe('Tenancy Test');
    expect(membership.role).toBe('owner');
  });

  it('gives a business an org named after the company', async () => {
    const { token } = await verifiedSignUp('business');
    const res = await request(app).get('/orgs').set('Authorization', `Bearer ${token}`);
    const [membership] = res.body.data.memberships;
    expect(membership.org.kind).toBe('business');
    expect(membership.org.name).toBe('Tenancy Test Ltd');
  });

  it('refuses a business with no company name, and an individual with one', async () => {
    const base = { password: `Pw!${randomUUID()}`, displayName: 'Half Stated' };
    const noCompany = await signUp({
      ...base,
      email: `orgs-nc-${randomUUID()}@stewra.invalid`,
      accountKind: 'business',
    });
    expect(noCompany.status).toBe(400);

    const strayCompany = await signUp({
      ...base,
      email: `orgs-sc-${randomUUID()}@stewra.invalid`,
      accountKind: 'individual',
      companyName: 'Should Not Be Here',
    });
    expect(strayCompany.status).toBe(400);

    const noKind = await signUp({ ...base, email: `orgs-nk-${randomUUID()}@stewra.invalid` });
    expect(noKind.status).toBe(400);
  });

  it('holds the invariant migration 063 established: every user owns an organization', async () => {
    // The one-transaction claim in authService.register is not provokable from outside — the org
    // insert has no failure mode a request can reach once validation has passed. What IS observable
    // is the state it protects: no registered user without an owner membership. Scoped to the accounts
    // this file registered, because sibling suites insert `users` rows straight into the table in
    // parallel and never go through registration — those rows say nothing about this path.
    const orphans = await db
      .selectFrom('users')
      .select('users.id')
      .where('users.email', 'in', createdEmails)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('org_members')
              .select('org_members.id')
              .whereRef('org_members.user_id', '=', 'users.id')
              .where('org_members.role', '=', 'owner'),
          ),
        ),
      )
      .execute();
    expect(orphans).toEqual([]);
  });
});

describe('individual orgs refuse invites until converted', () => {
  it('returns 409 from the service and the trigger refuses a direct insert', async () => {
    const { token, orgId, userId } = await verifiedSignUp('individual');

    const invite = await request(app)
      .post(`/orgs/${orgId}/invites`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'someone@stewra.invalid', role: 'viewer' });
    expect(invite.status).toBe(409);

    await expect(
      db
        .insertInto('org_invites')
        .values({
          org_id: orgId,
          email: 'direct@stewra.invalid',
          role: 'viewer',
          token_hash: 'a'.repeat(64),
          invited_by: userId,
          expires_at: new Date(Date.now() + 60_000),
        })
        .execute(),
    ).rejects.toThrow(/individual account/);
  });

  it('accepts invites once the owner converts it to a business', async () => {
    const { token, orgId } = await verifiedSignUp('individual');

    const convert = await request(app)
      .post(`/orgs/${orgId}/convert`)
      .set('Authorization', `Bearer ${token}`)
      .send({ companyName: 'Grown Up Ltd' });
    expect(convert.status).toBe(200);
    expect(convert.body.data.org.kind).toBe('business');
    expect(convert.body.data.org.name).toBe('Grown Up Ltd');

    const invite = await request(app)
      .post(`/orgs/${orgId}/invites`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'teammate@stewra.invalid', role: 'viewer' });
    expect(invite.status).toBe(201);

    // One-way: a second conversion is refused rather than used to rename the business.
    const again = await request(app)
      .post(`/orgs/${orgId}/convert`)
      .set('Authorization', `Bearer ${token}`)
      .send({ companyName: 'Renamed Through The Back Door' });
    expect(again.status).toBe(409);
  });

  it('POST /orgs creates a business, never a second individual org', async () => {
    const { token } = await verifiedSignUp('individual');
    const res = await request(app)
      .post('/orgs')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Second Venture' });
    expect(res.status).toBe(201);
    expect(res.body.data.org.kind).toBe('business');
  });
});
