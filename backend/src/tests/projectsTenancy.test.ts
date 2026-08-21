import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

/**
 * TENANCY of the runner plane and projects (migrations 064/065).
 *
 * The question is the one that matters about any org-scoped surface: can a member of one
 * organization see, bind, move, revoke or run against another organization's machines and projects?
 * Real router, real `requireAuth` → `requireEmailVerification` → `requireOrgMember` chain, real
 * Postgres. The assertions are the status codes a caller would receive — including the deliberate
 * 404 (not 403) for a foreign org, and the 409 CHOICE_REQUIRED that carries candidates instead of
 * picking one.
 *
 * The runner feature is a deploy flag read at module load, so it is pinned before the graph is
 * imported — the same way runnerService.test.ts does it.
 */

process.env['RUNNER_ENABLED'] = 'true';
process.env['RUNNER_DOWNLOAD_URL'] = 'https://downloads.example.test/stewra-runner';
process.env['RUNNER_MIN_VERSION'] = '0.2.0';
process.env['RUNNER_LATEST_VERSION'] = '0.2.0';

const { config } = await import('../config/unifiedConfig.js');
const { db, closeDb } = await import('../database/index.js');
const { errorHandler } = await import('../middleware/errorHandler.js');
const { organizationRepository } = await import('../tenancy/repositories/organizationRepository.js');
const { runnerDeviceRepository } = await import('../repositories/runnerDeviceRepository.js');
const { runnerService } = await import('../services/runnerService.js');
const projectRoutes = (await import('../routes/projects.js')).default;
const orgRunnerRoutes = (await import('../routes/orgRunner.js')).default;

const app = express();
app.use(express.json());
app.use('/orgs/:orgId/runner', orgRunnerRoutes);
app.use('/orgs/:orgId/projects', projectRoutes);
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
      email: `projects-tenancy-${randomUUID()}@stewra.invalid`,
      display_name: 'Projects Tenancy Test User',
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

/** A business org with a fresh owner. */
async function createOrg(name = 'Nurturing Lab Test'): Promise<{ owner: TestUser; orgId: string }> {
  const owner = await createUser();
  const { org } = await organizationRepository.create({
    kind: 'business',
    name,
    slug: `nl-test-${randomUUID().slice(0, 8)}`,
    createdBy: owner.id,
  });
  createdOrgs.push(org.id);
  return { owner, orgId: org.id };
}

async function addMember(orgId: string, role: 'admin' | 'viewer'): Promise<TestUser> {
  const user = await createUser();
  await db.insertInto('org_members').values({ org_id: orgId, user_id: user.id, role }).execute();
  return user;
}

const WORKSPACE = { id: 'ws_truetalk', name: 'product_advisor', path: '/Volumes/charan/projects/product_advisor' };

/** A paired machine in `orgId` that has said hello with one checkout — the state binding needs. */
async function pairedDevice(orgId: string, pairer: TestUser, name: string): Promise<string> {
  const { device } = await runnerDeviceRepository.registerDevice({
    orgId,
    userId: pairer.id,
    name,
    appVersion: '0.2.0',
    os: 'darwin',
  });
  await runnerService.recordCapabilities(device.id, {
    os: 'darwin',
    appVersion: '0.2.0',
    harnesses: [{ id: 'claude-code', available: true, version: '2.0.1' }],
    workspaces: [WORKSPACE],
  });
  return device.id;
}

async function createProject(orgId: string, as: TestUser, name = 'Truetalk'): Promise<string> {
  const res = await request(API)
    .post(`/orgs/${orgId}/projects`)
    .set('Authorization', as.auth)
    .send({ name, repoName: 'product_advisor', aliases: ['true talk'] });
  expect(res.status).toBe(201);
  return res.body.data.project.id as string;
}

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (createdOrgs.length > 0) {
    // Cascades take the devices, sessions, projects and bindings with the org.
    await db.deleteFrom('org_members').where('org_id', 'in', createdOrgs).execute();
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

describe('projects are invisible across organizations', () => {
  it('lists, reads and edits only within the path org — a foreign org is a 404', async () => {
    const a = await createOrg('Org A');
    const b = await createOrg('Org B');
    const projectId = await createProject(a.orgId, a.owner);

    const own = await request(API).get(`/orgs/${a.orgId}/projects`).set('Authorization', a.owner.auth);
    expect(own.status).toBe(200);
    expect(own.body.data.projects.map((p: { id: string }) => p.id)).toEqual([projectId]);

    // B's owner is not a member of A: 404, never 403 — the org id must not be confirmed to exist.
    expect((await request(API).get(`/orgs/${a.orgId}/projects`).set('Authorization', b.owner.auth)).status).toBe(404);
    expect(
      (await request(API).get(`/orgs/${a.orgId}/projects/${projectId}`).set('Authorization', b.owner.auth)).status,
    ).toBe(404);

    // And a project id from A does not resolve under B's own path either.
    expect(
      (await request(API).get(`/orgs/${b.orgId}/projects/${projectId}`).set('Authorization', b.owner.auth)).status,
    ).toBe(404);
    expect(
      (
        await request(API)
          .patch(`/orgs/${b.orgId}/projects/${projectId}`)
          .set('Authorization', b.owner.auth)
          .send({ name: 'Hijacked' })
      ).status,
    ).toBe(404);
  });

  it('lets a viewer read and refuses them every write', async () => {
    const a = await createOrg();
    const viewer = await addMember(a.orgId, 'viewer');
    const projectId = await createProject(a.orgId, a.owner);

    expect((await request(API).get(`/orgs/${a.orgId}/projects`).set('Authorization', viewer.auth)).status).toBe(200);
    expect(
      (
        await request(API)
          .post(`/orgs/${a.orgId}/projects`)
          .set('Authorization', viewer.auth)
          .send({ name: 'Stewra', repoName: 'Stewra' })
      ).status,
    ).toBe(403);
    expect(
      (await request(API).post(`/orgs/${a.orgId}/projects/${projectId}/archive`).set('Authorization', viewer.auth))
        .status,
    ).toBe(403);
  });

  it('keeps slugs unique per org, not globally', async () => {
    const a = await createOrg('Org A');
    const b = await createOrg('Org B');
    await createProject(a.orgId, a.owner, 'Stewra');
    await createProject(b.orgId, b.owner, 'Stewra');

    const dup = await request(API)
      .post(`/orgs/${a.orgId}/projects`)
      .set('Authorization', a.owner.auth)
      .send({ name: 'Stewra', repoName: 'Stewra' });
    expect(dup.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------------------------
// What speech-to-text is told to listen for
// ---------------------------------------------------------------------------------------------

describe('the spoken vocabulary', () => {
  it('carries project names, aliases and machine names across the orgs the person belongs to', async () => {
    const { projectService } = await import('../services/projectService.js');
    const a = await createOrg('Org A');
    const b = await createOrg('Org B');
    const member = await addMember(b.orgId, 'viewer');
    await db.insertInto('org_members').values({ org_id: a.orgId, user_id: member.id, role: 'viewer' }).execute();
    await createProject(a.orgId, a.owner, 'Truetalk');
    await pairedDevice(a.orgId, a.owner, 'Mac mini');
    await pairedDevice(b.orgId, b.owner, 'MacBook Pro');

    const words = await projectService.vocabularyForUser(member.id);
    expect(words).toEqual(expect.arrayContaining(['Truetalk', 'true talk', 'Mac mini', 'MacBook Pro']));

    // Someone outside both orgs hears none of it.
    expect(await projectService.vocabularyForUser((await createUser()).id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Machines
// ---------------------------------------------------------------------------------------------

describe('machines belong to the org that paired them', () => {
  it('lists and revokes only inside the org; a foreign org sees nothing', async () => {
    const a = await createOrg('Org A');
    const b = await createOrg('Org B');
    const deviceId = await pairedDevice(a.orgId, a.owner, 'Mac mini');

    const own = await request(API).get(`/orgs/${a.orgId}/runner/devices`).set('Authorization', a.owner.auth);
    expect(own.status).toBe(200);
    expect(own.body.data.devices.map((d: { id: string }) => d.id)).toEqual([deviceId]);

    const foreign = await request(API).get(`/orgs/${b.orgId}/runner/devices`).set('Authorization', b.owner.auth);
    expect(foreign.status).toBe(200);
    expect(foreign.body.data.devices).toEqual([]);

    // Revoking by id from the wrong org deletes nothing — and says so.
    const revoke = await request(API)
      .delete(`/orgs/${b.orgId}/runner/devices/${deviceId}`)
      .set('Authorization', b.owner.auth);
    expect(revoke.status).toBe(200);
    expect(revoke.body.data.revoked).toBe(false);
    expect(
      (await request(API).patch(`/orgs/${b.orgId}/runner/devices/${deviceId}`).set('Authorization', b.owner.auth).send({ environment: 'production' }))
        .status,
    ).toBe(404);
  });

  it('a pairing code minted under an org registers the machine in that org', async () => {
    const a = await createOrg();
    const pair = await request(API).post(`/orgs/${a.orgId}/runner/pair`).set('Authorization', a.owner.auth);
    expect(pair.status).toBe(201);
    expect(pair.body.data.orgId).toBe(a.orgId);

    // The machine claims with the code alone — it never learns an org id exists.
    const claimed = await runnerService.claimToken({
      code: pair.body.data.code,
      deviceName: 'MacBook Pro',
      appVersion: '0.2.0',
      os: 'darwin',
    });
    const row = await db
      .selectFrom('runner_devices')
      .select('org_id')
      .where('id', '=', claimed.device.id)
      .executeTakeFirstOrThrow();
    expect(row.org_id).toBe(a.orgId);
  });

  it('moves a machine only when the caller is its pairer, and refuses a no-op move', async () => {
    const personal = await createOrg('Personal');
    const company = await createOrg('Company');
    // The pairer is an admin of both — the founder's two orgs.
    await db.insertInto('org_members').values({ org_id: company.orgId, user_id: personal.owner.id, role: 'admin' }).execute();
    // Another admin of BOTH orgs — role is not the question, pairing is.
    const otherAdmin = await addMember(personal.orgId, 'admin');
    await db.insertInto('org_members').values({ org_id: company.orgId, user_id: otherAdmin.id, role: 'admin' }).execute();
    const deviceId = await pairedDevice(personal.orgId, personal.owner, 'Mac mini');

    const notPairer = await request(API)
      .post(`/orgs/${personal.orgId}/runner/devices/${deviceId}/move`)
      .set('Authorization', otherAdmin.auth)
      .send({ toOrgId: company.orgId });
    expect(notPairer.status).toBe(409);
    expect(notPairer.body.error.message).toContain('paired');

    // A destination the caller is not even a member of does not exist from here.
    const stranger = await createOrg('Stranger');
    const notMember = await request(API)
      .post(`/orgs/${personal.orgId}/runner/devices/${deviceId}/move`)
      .set('Authorization', personal.owner.auth)
      .send({ toOrgId: stranger.orgId });
    expect(notMember.status).toBe(404);

    const moved = await request(API)
      .post(`/orgs/${personal.orgId}/runner/devices/${deviceId}/move`)
      .set('Authorization', personal.owner.auth)
      .send({ toOrgId: company.orgId });
    expect(moved.status).toBe(200);
    expect(moved.body.data.device.orgId).toBe(company.orgId);

    // It is gone from the old org and present in the new one.
    expect(
      (await request(API).get(`/orgs/${personal.orgId}/runner/devices`).set('Authorization', personal.owner.auth)).body
        .data.devices,
    ).toEqual([]);
    const again = await request(API)
      .post(`/orgs/${company.orgId}/runner/devices/${deviceId}/move`)
      .set('Authorization', personal.owner.auth)
      .send({ toOrgId: company.orgId });
    expect(again.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------------------------
// Bindings — the database and the service both refuse to cross tenants
// ---------------------------------------------------------------------------------------------

describe('binding a project to a checkout', () => {
  it('binds a reported checkout, refuses an unreported one, and refuses a foreign machine', async () => {
    const a = await createOrg('Org A');
    const b = await createOrg('Org B');
    const projectId = await createProject(a.orgId, a.owner);
    const ownDevice = await pairedDevice(a.orgId, a.owner, 'Mac mini');
    const foreignDevice = await pairedDevice(b.orgId, b.owner, 'Someone else');

    // Not reported by the machine: the volume may be unmounted. The sentence tells the user what to do.
    const unreported = await request(API)
      .post(`/orgs/${a.orgId}/projects/${projectId}/workspaces`)
      .set('Authorization', a.owner.auth)
      .send({ deviceId: ownDevice, workspaceId: 'ws_not_reported' });
    expect(unreported.status).toBe(409);
    expect(unreported.body.error.message).toContain('Rescan');

    // Another org's machine does not exist from here.
    const foreign = await request(API)
      .post(`/orgs/${a.orgId}/projects/${projectId}/workspaces`)
      .set('Authorization', a.owner.auth)
      .send({ deviceId: foreignDevice, workspaceId: WORKSPACE.id });
    expect(foreign.status).toBe(404);

    const bound = await request(API)
      .post(`/orgs/${a.orgId}/projects/${projectId}/workspaces`)
      .set('Authorization', a.owner.auth)
      .send({ deviceId: ownDevice, workspaceId: WORKSPACE.id });
    expect(bound.status).toBe(201);
    expect(bound.body.data.binding.workspacePath).toBe(WORKSPACE.path);

    // One checkout, one project: binding the same checkout to a second project is refused.
    const second = await createProject(a.orgId, a.owner, 'Stewra');
    const twice = await request(API)
      .post(`/orgs/${a.orgId}/projects/${second}/workspaces`)
      .set('Authorization', a.owner.auth)
      .send({ deviceId: ownDevice, workspaceId: WORKSPACE.id });
    expect(twice.status).toBe(409);

    // The org-wide binding list is what the fleet matrix renders.
    const all = await request(API).get(`/orgs/${a.orgId}/projects/bindings`).set('Authorization', a.owner.auth);
    expect(all.status).toBe(200);
    expect(all.body.data.bindings).toHaveLength(1);
    expect(all.body.data.bindings[0].projectId).toBe(projectId);
  });

  it('the database itself refuses a binding whose project and device disagree on org', async () => {
    const a = await createOrg('Org A');
    const b = await createOrg('Org B');
    const projectId = await createProject(a.orgId, a.owner);
    const foreignDevice = await pairedDevice(b.orgId, b.owner, 'Someone else');

    // Straight at the table, past every service check: the composite foreign keys must hold.
    await expect(
      db
        .insertInto('project_workspaces')
        .values({
          org_id: a.orgId,
          project_id: projectId,
          device_id: foreignDevice,
          workspace_id: WORKSPACE.id,
          workspace_name: WORKSPACE.name,
          workspace_path: WORKSPACE.path,
          git_remote: null,
          bound_by: a.owner.id,
        })
        .execute(),
    ).rejects.toThrow(/foreign key/i);
  });
});

// ---------------------------------------------------------------------------------------------
// Starting by project: the server never picks a machine
// ---------------------------------------------------------------------------------------------

describe('starting a session by project', () => {
  it('refuses an unbound project, and asks — with candidates — when it is on two machines', async () => {
    const a = await createOrg();
    const projectId = await createProject(a.orgId, a.owner);

    const unbound = await request(API)
      .post(`/orgs/${a.orgId}/runner/sessions`)
      .set('Authorization', a.owner.auth)
      .send({ projectId, harness: 'claude-code', prompt: 'run the tests' });
    expect(unbound.status).toBe(409);

    const mini = await pairedDevice(a.orgId, a.owner, 'Mac mini');
    const mbp = await pairedDevice(a.orgId, a.owner, 'MacBook Pro');
    for (const deviceId of [mini, mbp]) {
      const bound = await request(API)
        .post(`/orgs/${a.orgId}/projects/${projectId}/workspaces`)
        .set('Authorization', a.owner.auth)
        .send({ deviceId, workspaceId: WORKSPACE.id });
      expect(bound.status).toBe(201);
    }

    const ambiguous = await request(API)
      .post(`/orgs/${a.orgId}/runner/sessions`)
      .set('Authorization', a.owner.auth)
      .send({ projectId, harness: 'claude-code', prompt: 'run the tests' });
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.body.error.code).toBe('CHOICE_REQUIRED');
    // The candidates ride in `details`: id in `field`, human name in `message`. This is how the fleet
    // page and the chat layer ask "which machine?" instead of guessing.
    expect(ambiguous.body.error.details).toEqual(
      expect.arrayContaining([
        { field: mini, message: 'Mac mini' },
        { field: mbp, message: 'MacBook Pro' },
      ]),
    );
    expect(ambiguous.body.error.details).toHaveLength(2);

    // Naming a machine the project is NOT bound on is a 409 too — not a silent substitution.
    const stranger = await pairedDevice(a.orgId, a.owner, 'Unbound box');
    const wrongDevice = await request(API)
      .post(`/orgs/${a.orgId}/runner/sessions`)
      .set('Authorization', a.owner.auth)
      .send({ projectId, deviceId: stranger, harness: 'claude-code', prompt: 'run the tests' });
    expect(wrongDevice.status).toBe(409);
  });

  it('refuses a project from another org even when the caller names one of their own machines', async () => {
    const a = await createOrg('Org A');
    const b = await createOrg('Org B');
    const foreignProject = await createProject(b.orgId, b.owner);
    const ownDevice = await pairedDevice(a.orgId, a.owner, 'Mac mini');

    const res = await request(API)
      .post(`/orgs/${a.orgId}/runner/sessions`)
      .set('Authorization', a.owner.auth)
      .send({ projectId: foreignProject, deviceId: ownDevice, harness: 'claude-code', prompt: 'x' });
    expect(res.status).toBe(404);
  });
});
