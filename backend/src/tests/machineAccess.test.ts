import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { HostIdentity } from '@stewra/shared-types';

/**
 * "That machine is right here — may I look at it?"
 *
 * A Stewra Bridge is paired to a PERSON and a Stewra Runner to an ORG, so the two can be on the same
 * physical Mac and still be strangers. What is proven here is the whole route out of that dead end:
 * both halves report a host identity, the server matches them, the person outside the org can ASK, an
 * admin inside it decides, and — this is the part that matters most — nothing about the asking widens
 * anyone's access on its own. Real Postgres, real router, real `requireAuth` →
 * `requireEmailVerification` → `requireOrgMember` chain.
 *
 * The runner feature is a deploy flag read at module load, so it is pinned before the graph is
 * imported, the same way runnerService.test.ts and projectsTenancy.test.ts do it.
 */

process.env['RUNNER_ENABLED'] = 'true';
process.env['RUNNER_DOWNLOAD_URL'] = 'https://downloads.example.test/stewra-runner';
process.env['RUNNER_MIN_VERSION'] = '0.2.0';
process.env['RUNNER_LATEST_VERSION'] = '0.2.0';

const { config } = await import('../config/unifiedConfig.js');
const { db, closeDb } = await import('../database/index.js');
const { errorHandler } = await import('../middleware/errorHandler.js');
const { organizationRepository } = await import('../tenancy/repositories/organizationRepository.js');
const { bridgeDeviceRepository } = await import('../repositories/bridgeDeviceRepository.js');
const { runnerDeviceRepository } = await import('../repositories/runnerDeviceRepository.js');
const { machineAccessRepository, hostIdOf } = await import(
  '../repositories/machineAccessRepository.js'
);
const { machineAccessService } = await import('../services/machineAccessService.js');
const machineAccessRoutes = (await import('../routes/machineAccess.js')).default;

const app = express();
app.use(express.json());
app.use('/orgs/:orgId/machine-access', machineAccessRoutes);
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const API = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const PASSWORD_HASH = await bcrypt.hash(randomUUID(), 10);
const createdUsers: string[] = [];
const createdOrgs: string[] = [];

interface TestUser {
  readonly id: string;
  readonly auth: string;
}

async function createUser(): Promise<TestUser> {
  const row = await db
    .insertInto('users')
    .values({
      email: `machine-access-${randomUUID()}@stewra.invalid`,
      display_name: 'Machine Access Test User',
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
  return { id: row.id, auth };
}

async function createOrg(name: string): Promise<{ owner: TestUser; orgId: string }> {
  const owner = await createUser();
  const { org } = await organizationRepository.create({
    kind: 'business',
    name,
    slug: `ma-test-${randomUUID().slice(0, 8)}`,
    createdBy: owner.id,
  });
  createdOrgs.push(org.id);
  return { owner, orgId: org.id };
}

/** A fresh identity for a physical computer, unique per test so suites cannot collide on one host. */
function aMac(hostname: string): HostIdentity {
  return { kind: 'darwin-platform-uuid', value: randomUUID(), hostname };
}

/** A runner paired to `orgId` that has told the server which computer it is on. */
async function runnerOn(orgId: string, pairer: TestUser, name: string, host: HostIdentity): Promise<string> {
  const { device } = await runnerDeviceRepository.registerDevice({
    orgId,
    userId: pairer.id,
    name,
    appVersion: '0.3.0',
    os: 'darwin',
  });
  await machineAccessService.noteRunnerHost(device.id, host);
  return device.id;
}

/** A bridge paired to `user` that has told the server which computer it is on. */
async function bridgeOn(user: TestUser, host: HostIdentity): Promise<string> {
  const { device } = await bridgeDeviceRepository.registerDevice({
    userId: user.id,
    name: 'Stewra Bridge',
    appVersion: '1.4.0',
    consentVersion: 1,
    consentedAt: new Date(),
  });
  await machineAccessService.noteBridgeHost(device.id, host);
  return device.id;
}

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (createdOrgs.length > 0) {
    // Cascades take the devices and the access requests with the org.
    await db.deleteFrom('org_members').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('organizations').where('id', 'in', createdOrgs).execute();
  }
  if (createdUsers.length > 0) {
    await db.deleteFrom('bridge_devices').where('user_id', 'in', createdUsers).execute();
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
// Matching two devices to one computer
// ---------------------------------------------------------------------------------------------

describe('recognising that a bridge and a runner are the same computer', () => {
  it('hashes kind and value together, so two identifiers from different sources never collide', () => {
    const value = randomUUID();
    expect(hostIdOf({ kind: 'darwin-platform-uuid', value, hostname: 'a' })).toBe(
      // The hostname is NOT in the hash: renaming a Mac must not turn it into a different machine.
      hostIdOf({ kind: 'darwin-platform-uuid', value, hostname: 'renamed-since' }),
    );
    expect(hostIdOf({ kind: 'darwin-platform-uuid', value, hostname: 'a' })).not.toBe(
      hostIdOf({ kind: 'linux-machine-id', value, hostname: 'a' }),
    );
  });

  it('never matches a machine that has not reported an identity', async () => {
    const acme = await createOrg('Acme Machine Co');
    const outsider = await createUser();
    // A runner with no host id at all — the state every device is in before it upgrades.
    await runnerDeviceRepository.registerDevice({
      orgId: acme.orgId,
      userId: acme.owner.id,
      name: 'Silent Mac',
      appVersion: '0.2.0',
      os: 'darwin',
    });
    await bridgeOn(outsider, aMac('some-other-mac'));

    // Two NULLs are not the same machine. If they were, every un-upgraded device in the install would
    // look like every other one, and the first person to ask would be asking about all of them.
    expect(await machineAccessService.inspectOwnMachine(outsider.id)).toEqual({ kind: 'no-runner', hostname: 'some-other-mac' });
  });

  it('says nothing to ask for when the bridge itself has never reported where it is', async () => {
    const user = await createUser();
    await bridgeDeviceRepository.registerDevice({
      userId: user.id,
      name: 'Old Bridge',
      appVersion: '1.3.0',
      consentVersion: 1,
      consentedAt: new Date(),
    });
    expect(await machineAccessService.inspectOwnMachine(user.id)).toEqual({ kind: 'host-unknown' });
  });

  it('asks for nothing when the machine is already in one of the person\'s own organizations', async () => {
    const acme = await createOrg('Acme Own Machine');
    const host = aMac('mac-mini-m2');
    await runnerOn(acme.orgId, acme.owner, 'Mac mini', host);
    await bridgeOn(acme.owner, host);

    expect(await machineAccessService.inspectOwnMachine(acme.owner.id)).toEqual({
      kind: 'already-visible',
      deviceName: 'Mac mini',
      orgId: acme.orgId,
    });
    // And asking is a no-op, not a request filed against an org they are already in.
    expect((await machineAccessService.askForOwnMachine(acme.owner.id)).kind).toBe('already-visible');
    expect(await machineAccessRepository.listByOrg(acme.orgId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Asking, and being answered
// ---------------------------------------------------------------------------------------------

describe('asking the owning organization for sight of this machine', () => {
  it('offers the ask, files it once however often it is repeated, and shows it to the org', async () => {
    const acme = await createOrg('Acme Shared Desk');
    const outsider = await createUser();
    const host = aMac('shared-desk-mac');
    const deviceId = await runnerOn(acme.orgId, acme.owner, 'Front Desk Mac', host);
    await bridgeOn(outsider, host);

    // Before anything is asked: the machine is right here, and asking is available.
    expect(await machineAccessService.inspectOwnMachine(outsider.id)).toEqual({
      kind: 'can-ask',
      deviceName: 'Front Desk Mac',
      orgName: 'Acme Shared Desk',
    });
    // Inspecting must NOT have filed anything — it runs on turns the person may not have meant.
    expect(await machineAccessRepository.listByOrg(acme.orgId)).toEqual([]);

    expect((await machineAccessService.askForOwnMachine(outsider.id)).kind).toBe('asked');
    // A reconnecting bridge asking again is the same request, not a second one for an admin to wade
    // through. `pending`, not `asked`: the second call did not file anything and must not claim it did.
    expect((await machineAccessService.askForOwnMachine(outsider.id)).kind).toBe('pending');

    const listed = await request(API)
      .get(`/orgs/${acme.orgId}/machine-access`)
      .set('Authorization', acme.owner.auth);
    expect(listed.status).toBe(200);
    expect(listed.body.data.requests).toHaveLength(1);
    expect(listed.body.data.requests[0]).toMatchObject({
      deviceId,
      deviceName: 'Front Desk Mac',
      requestedByUserId: outsider.id,
      hostname: 'shared-desk-mac',
      status: 'pending',
    });
  });

  it('grants sight of exactly one machine when an admin approves, and nothing more', async () => {
    const acme = await createOrg('Acme Approves');
    const outsider = await createUser();
    const host = aMac('approved-mac');
    const deviceId = await runnerOn(acme.orgId, acme.owner, 'Approved Mac', host);
    // A SECOND machine in the same org, on a different computer: approving the first must not reveal it.
    const otherDeviceId = await runnerOn(acme.orgId, acme.owner, 'Other Mac', aMac('other-mac'));
    await bridgeOn(outsider, host);
    await machineAccessService.askForOwnMachine(outsider.id);

    const [pending] = await machineAccessRepository.listByOrg(acme.orgId);
    if (pending === undefined) throw new Error('no request to decide');
    const decided = await request(API)
      .post(`/orgs/${acme.orgId}/machine-access/${pending.id}/decide`)
      .set('Authorization', acme.owner.auth)
      .send({ approve: true });
    expect(decided.status).toBe(200);
    expect(decided.body.data.request.status).toBe('approved');

    expect(await machineAccessRepository.isGranted(outsider.id, deviceId)).toBe(true);
    expect(await machineAccessRepository.isGranted(outsider.id, otherDeviceId)).toBe(false);
    expect(await machineAccessService.grantedDeviceIds(outsider.id)).toEqual([deviceId]);
    // Approval is sight of a machine — NOT membership. Their own view of that org is unchanged.
    const memberships = await organizationRepository.listForUser(outsider.id);
    expect(memberships.map((m) => m.org.id)).not.toContain(acme.orgId);
    expect((await machineAccessService.inspectOwnMachine(outsider.id)).kind).toBe('granted');
  });

  it('reports a refusal as an answer and never quietly re-asks it', async () => {
    const acme = await createOrg('Acme Refuses');
    const outsider = await createUser();
    const host = aMac('refused-mac');
    await runnerOn(acme.orgId, acme.owner, 'Refused Mac', host);
    await bridgeOn(outsider, host);
    await machineAccessService.askForOwnMachine(outsider.id);

    const [pending] = await machineAccessRepository.listByOrg(acme.orgId);
    if (pending === undefined) throw new Error('no request to decide');
    const denied = await request(API)
      .post(`/orgs/${acme.orgId}/machine-access/${pending.id}/decide`)
      .set('Authorization', acme.owner.auth)
      .send({ approve: false });
    expect(denied.status).toBe(200);
    expect(denied.body.data.request.status).toBe('denied');

    expect((await machineAccessService.inspectOwnMachine(outsider.id)).kind).toBe('denied');
    // Asking again files nothing: a no is an answer, and re-asking on every reconnect would be spam
    // with a permission prompt attached.
    expect((await machineAccessService.askForOwnMachine(outsider.id)).kind).toBe('denied');
    expect(await machineAccessRepository.listByOrg(acme.orgId)).toHaveLength(1);

    // And a second decision on a settled request is a 409, not a silent overwrite of somebody's answer.
    const again = await request(API)
      .post(`/orgs/${acme.orgId}/machine-access/${pending.id}/decide`)
      .set('Authorization', acme.owner.auth)
      .send({ approve: true });
    expect(again.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------------------------
// The boundary between tenants
// ---------------------------------------------------------------------------------------------

describe('who may see and decide a request', () => {
  it('hides the queue from outsiders, refuses a viewer the decision, and 404s a foreign org', async () => {
    const acme = await createOrg('Acme Boundary');
    const other = await createOrg('Other Boundary Co');
    const outsider = await createUser();
    const host = aMac('boundary-mac');
    await runnerOn(acme.orgId, acme.owner, 'Boundary Mac', host);
    await bridgeOn(outsider, host);
    await machineAccessService.askForOwnMachine(outsider.id);
    const [pending] = await machineAccessRepository.listByOrg(acme.orgId);
    if (pending === undefined) throw new Error('no request to decide');

    // The person who asked is not a member: 404, never 403 — the org id must not be confirmed to exist.
    expect((await request(API).get(`/orgs/${acme.orgId}/machine-access`).set('Authorization', outsider.auth)).status).toBe(404);
    expect(
      (await request(API).get(`/orgs/${acme.orgId}/machine-access`).set('Authorization', other.owner.auth)).status,
    ).toBe(404);
    expect(
      (
        await request(API)
          .post(`/orgs/${acme.orgId}/machine-access/${pending.id}/decide`)
          .set('Authorization', other.owner.auth)
          .send({ approve: true })
      ).status,
    ).toBe(404);

    // A viewer of the org may SEE what has been asked of it and may not answer for it.
    const viewer = await createUser();
    await db.insertInto('org_members').values({ org_id: acme.orgId, user_id: viewer.id, role: 'viewer' }).execute();
    expect((await request(API).get(`/orgs/${acme.orgId}/machine-access`).set('Authorization', viewer.auth)).status).toBe(200);
    expect(
      (
        await request(API)
          .post(`/orgs/${acme.orgId}/machine-access/${pending.id}/decide`)
          .set('Authorization', viewer.auth)
          .send({ approve: true })
      ).status,
    ).toBe(403);

    // Nothing above moved it.
    expect((await machineAccessRepository.latestFor(outsider.id, pending.deviceId))?.status).toBe('pending');
  });

  it('will not let one org decide a request that belongs to another', async () => {
    const acme = await createOrg('Acme Cross Decide');
    const other = await createOrg('Other Cross Decide');
    const outsider = await createUser();
    const host = aMac('cross-decide-mac');
    await runnerOn(acme.orgId, acme.owner, 'Cross Mac', host);
    await bridgeOn(outsider, host);
    await machineAccessService.askForOwnMachine(outsider.id);
    const [pending] = await machineAccessRepository.listByOrg(acme.orgId);
    if (pending === undefined) throw new Error('no request to decide');

    // `other.owner` is an owner — of the wrong org. The org id in the path is what scopes the UPDATE.
    const res = await request(API)
      .post(`/orgs/${other.orgId}/machine-access/${pending.id}/decide`)
      .set('Authorization', other.owner.auth)
      .send({ approve: true });
    expect(res.status).toBe(409);
    expect((await machineAccessRepository.latestFor(outsider.id, pending.deviceId))?.status).toBe('pending');
  });
});
