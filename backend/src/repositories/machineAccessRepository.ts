import { createHash } from 'node:crypto';
import type { HostIdentity, MachineAccessRequest } from '@stewra/shared-types';
import type { Selectable } from 'kysely';
import { db } from '../database/index.js';
import type { MachineAccessRequestsTable } from '../database/types.js';

/**
 * Which computer a device is on, and who may see it.
 *
 * TENANCY. Reads and writes here come in two shapes and the difference matters. Everything an ADMIN does
 * — listing requests, deciding one — is scoped by a required, non-nullable `orgId` taken from the `:orgId`
 * path segment, exactly as `runnerDeviceRepository` documents. Everything a DEVICE originates — a bridge
 * or runner reporting its host on hello — is scoped by the device id its token resolved to, and by
 * nothing else. `hostFor` is the one query that deliberately crosses tenants: its entire job is to find
 * the runner device on a given physical machine WHOEVER owns it, because that is the question a bridge on
 * that machine is asking. It returns the org id so the caller can see the boundary it is standing at; it
 * grants nothing.
 */

/**
 * The id the server matches machines on: SHA-256 of `kind:value`.
 *
 * Derived here rather than on the client so there is exactly one implementation of the rule, and hashed
 * because a hardware UUID is a durable identifier for someone's physical computer that this database has
 * no reason to hold in plaintext. `kind` is inside the hash on purpose — two identifiers read from
 * different sources are not the same fact and must not collide.
 */
export function hostIdOf(host: HostIdentity): string {
  return createHash('sha256').update(`${host.kind}:${host.value}`, 'utf8').digest('hex');
}

function toModel(row: Selectable<MachineAccessRequestsTable>): MachineAccessRequest {
  return {
    id: row.id,
    orgId: row.org_id,
    deviceId: row.device_id,
    deviceName: row.device_name,
    requestedByUserId: row.requested_by_user_id,
    requestedByName: row.requested_by_name,
    hostname: row.hostname,
    status: row.status,
    requestedAt: row.requested_at.toISOString(),
    decidedAt: row.decided_at === null ? null : row.decided_at.toISOString(),
  };
}

/** One runner device, as seen from outside its org — enough to name it and to see whose it is. */
export interface HostRunnerDevice {
  readonly deviceId: string;
  readonly orgId: string;
  readonly name: string;
}

class MachineAccessRepository {
  /** A bridge reported which machine it is on. Device-scoped: the token already proved which bridge. */
  async recordBridgeHost(bridgeDeviceId: string, hostId: string, hostname: string): Promise<void> {
    await db
      .updateTable('bridge_devices')
      .set({ host_id: hostId, hostname })
      .where('id', '=', bridgeDeviceId)
      .execute();
  }

  /** A runner reported which machine it is on. Device-scoped, for the same reason. */
  async recordRunnerHost(deviceId: string, hostId: string, hostname: string): Promise<void> {
    await db
      .updateTable('runner_devices')
      .set({ host_id: hostId, hostname })
      .where('id', '=', deviceId)
      .execute();
  }

  /** What a bridge last told us about itself. Null when it never did — an older build, or a platform we read no id for. */
  async bridgeHost(bridgeDeviceId: string): Promise<{ hostId: string; hostname: string } | null> {
    const row = await db
      .selectFrom('bridge_devices')
      .select(['host_id', 'hostname'])
      .where('id', '=', bridgeDeviceId)
      .executeTakeFirst();
    if (row === undefined || row.host_id === null || row.hostname === null) return null;
    return { hostId: row.host_id, hostname: row.hostname };
  }

  /** The bridge devices this user has that have told us where they are. */
  async bridgeHostsForUser(userId: string): Promise<ReadonlyArray<{ bridgeDeviceId: string; hostId: string; hostname: string }>> {
    const rows = await db
      .selectFrom('bridge_devices')
      .select(['id', 'host_id', 'hostname'])
      .where('user_id', '=', userId)
      .where('host_id', 'is not', null)
      .execute();
    return rows.flatMap((r) =>
      r.host_id === null || r.hostname === null
        ? []
        : [{ bridgeDeviceId: r.id, hostId: r.host_id, hostname: r.hostname }],
    );
  }

  /**
   * The runner devices on a given physical machine, whoever owns them.
   *
   * Crosses tenants by design — see the file docblock. A NULL `host_id` is never a match: the `is not
   * null` is not decoration, it is what stops every machine that has not reported an id from looking
   * like every other one.
   */
  async hostFor(hostId: string): Promise<readonly HostRunnerDevice[]> {
    const rows = await db
      .selectFrom('runner_devices')
      .select(['id', 'org_id', 'name'])
      .where('host_id', '=', hostId)
      .execute();
    return rows.map((r) => ({ deviceId: r.id, orgId: r.org_id, name: r.name }));
  }

  /** The most recent request this person made about this machine, decided or not. */
  async latestFor(userId: string, deviceId: string): Promise<MachineAccessRequest | null> {
    const row = await db
      .selectFrom('machine_access_requests')
      .selectAll()
      .where('requested_by_user_id', '=', userId)
      .where('device_id', '=', deviceId)
      .orderBy('requested_at', 'desc')
      .executeTakeFirst();
    return row === undefined ? null : toModel(row);
  }

  /**
   * File a request, or return the open one that already exists.
   *
   * `onConflict … doNothing` against `uq_machine_access_open` is what makes a reconnecting bridge idempotent
   * instead of a source of duplicate rows for an admin to wade through.
   */
  async open(input: {
    orgId: string;
    deviceId: string;
    deviceName: string;
    bridgeDeviceId: string;
    userId: string;
    userName: string;
    hostname: string;
    hostId: string;
  }): Promise<MachineAccessRequest> {
    const inserted = await db
      .insertInto('machine_access_requests')
      .values({
        org_id: input.orgId,
        device_id: input.deviceId,
        device_name: input.deviceName,
        bridge_device_id: input.bridgeDeviceId,
        requested_by_user_id: input.userId,
        requested_by_name: input.userName,
        hostname: input.hostname,
        host_id: input.hostId,
      })
      .onConflict((oc) => oc.doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted !== undefined) return toModel(inserted);

    const existing = await db
      .selectFrom('machine_access_requests')
      .selectAll()
      .where('device_id', '=', input.deviceId)
      .where('requested_by_user_id', '=', input.userId)
      .where('status', '=', 'pending')
      .executeTakeFirstOrThrow();
    return toModel(existing);
  }

  /** Every request against this org's machines, newest first. Org-scoped. */
  async listByOrg(orgId: string): Promise<readonly MachineAccessRequest[]> {
    const rows = await db
      .selectFrom('machine_access_requests')
      .selectAll()
      .where('org_id', '=', orgId)
      .orderBy('requested_at', 'desc')
      .execute();
    return rows.map(toModel);
  }

  /**
   * Approve or refuse. Org-scoped, and only from `pending` — deciding an already-decided request would
   * silently overwrite somebody's answer, so the UPDATE matches nothing and the caller gets to say so.
   */
  async decide(
    orgId: string,
    requestId: string,
    approve: boolean,
    decidedBy: string,
  ): Promise<MachineAccessRequest | null> {
    const row = await db
      .updateTable('machine_access_requests')
      .set({
        status: approve ? 'approved' : 'denied',
        decided_at: new Date(),
        decided_by: decidedBy,
      })
      .where('id', '=', requestId)
      .where('org_id', '=', orgId)
      .where('status', '=', 'pending')
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? null : toModel(row);
  }

  /** May this person see this machine? An approved row IS the grant; there is no second table. */
  async isGranted(userId: string, deviceId: string): Promise<boolean> {
    const row = await db
      .selectFrom('machine_access_requests')
      .select('id')
      .where('requested_by_user_id', '=', userId)
      .where('device_id', '=', deviceId)
      .where('status', '=', 'approved')
      .executeTakeFirst();
    return row !== undefined;
  }

  /** Every machine outside their own orgs this person has been granted sight of. */
  async grantedDeviceIds(userId: string): Promise<readonly string[]> {
    const rows = await db
      .selectFrom('machine_access_requests')
      .select('device_id')
      .where('requested_by_user_id', '=', userId)
      .where('status', '=', 'approved')
      .execute();
    return rows.map((r) => r.device_id);
  }
}

export const machineAccessRepository = new MachineAccessRepository();
