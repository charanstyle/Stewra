import type {
  DecideMachineAccessRequest,
  DecideMachineAccessResponse,
  HostIdentity,
  ListMachineAccessRequestsResponse,
  MachineAccessRequest,
} from '@stewra/shared-types';
import { auditWriter } from '../control-plane/audit/auditWriter.js';
import { hostIdOf, machineAccessRepository } from '../repositories/machineAccessRepository.js';
import { userRepository } from '../repositories/userRepository.js';
import { organizationRepository } from '../tenancy/repositories/organizationRepository.js';
import { ConflictError, NotFoundError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import type { OrgActor } from './runnerService.js';

/**
 * "That machine is right here — may I look at it?"
 *
 * A Stewra Bridge is paired to a PERSON; a Stewra Runner is paired to an ORG. So a bridge can be running
 * on the exact Mac a runner reports from and still be unable to answer "what's running here?" — the two
 * belong to different tenants, and until now the conversation ended at "I don't have a machine called
 * that", with no route from the dead end to permission. That sentence was true and useless, which is the
 * worst combination a product can offer.
 *
 * This service is that route. It never widens anyone's access on its own: matching two devices to one
 * physical computer is a FACT, and the org's admins turn it into permission or refuse to. And what they
 * can grant is deliberately small — see `MachineAccessRequest` in shared-types: sight of one machine, not
 * membership, not the other machines in the org, and not the ability to start a session on it.
 */

/** What Stewra can say about the machine a bridge is sitting on. Every case is a different sentence. */
export type MachineAccessOutcome =
  /** The bridge never told us where it is: an older build, or a platform with no identifier we read. */
  | { readonly kind: 'host-unknown' }
  /** Nothing on this machine is paired as a runner. Not a permission problem — an installation one. */
  | { readonly kind: 'no-runner'; readonly hostname: string }
  /** The machine is in an org this person is already in. They can see it; nothing to ask for. */
  | { readonly kind: 'already-visible'; readonly deviceName: string; readonly orgId: string }
  /** Someone else's org owns it and this person has been granted sight of it. */
  | {
      readonly kind: 'granted';
      readonly deviceName: string;
      readonly deviceId: string;
      readonly orgName: string;
    }
  /** A request is open and waiting on that org's admins. */
  | { readonly kind: 'pending'; readonly deviceName: string; readonly orgName: string }
  /** They asked and were refused. Said once, not re-asked — a refusal is an answer. */
  | { readonly kind: 'denied'; readonly deviceName: string; readonly orgName: string }
  /** Another org owns it, nothing has been asked yet, and asking is available. */
  | { readonly kind: 'can-ask'; readonly deviceName: string; readonly orgName: string }
  /** A request was just filed on their behalf. */
  | { readonly kind: 'asked'; readonly deviceName: string; readonly orgName: string };

/** The machine a bridge is on, with everything needed to ask about it. Internal to this service. */
interface LocatedMachine {
  readonly bridgeDeviceId: string;
  readonly hostId: string;
  readonly hostname: string;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly orgId: string;
  readonly orgName: string;
}

class MachineAccessService {
  /** A bridge said which computer it is on. Device-scoped — its token already proved which bridge. */
  async noteBridgeHost(bridgeDeviceId: string, host: HostIdentity): Promise<void> {
    await machineAccessRepository.recordBridgeHost(bridgeDeviceId, hostIdOf(host), host.hostname);
  }

  /** A runner said which computer it is on. Same shape, other half of the pair. */
  async noteRunnerHost(deviceId: string, host: HostIdentity): Promise<void> {
    await machineAccessRepository.recordRunnerHost(deviceId, hostIdOf(host), host.hostname);
  }

  /**
   * Where does this person stand with the machine their bridge is running on?
   *
   * Read-only, deliberately. The conversational path calls this on turns where the user may not be
   * talking about this machine at all, and filing a request against another org's admins because
   * somebody typed a machine name that happened not to resolve would be spam with a permission prompt
   * attached. `can-ask` is the answer that says asking is available; `askForOwnMachine` is what asks.
   */
  private async locate(userId: string): Promise<LocatedMachine | MachineAccessOutcome> {
    const bridges = await machineAccessRepository.bridgeHostsForUser(userId);
    const bridge = bridges[0];
    if (bridge === undefined) return { kind: 'host-unknown' };

    const onThisMachine = await machineAccessRepository.hostFor(bridge.hostId);
    const device = onThisMachine[0];
    if (device === undefined) return { kind: 'no-runner', hostname: bridge.hostname };

    const org = await organizationRepository.findById(device.orgId);
    // The org row is the only place the owning tenant has a human name. If it is gone the device row
    // should have cascaded with it, so this is a state we do not model a sentence for.
    if (org === null) throw new NotFoundError('That machine is paired to an organization that no longer exists');

    return {
      bridgeDeviceId: bridge.bridgeDeviceId,
      hostId: bridge.hostId,
      hostname: bridge.hostname,
      deviceId: device.deviceId,
      deviceName: device.name,
      orgId: device.orgId,
      orgName: org.name,
    };
  }

  /** Read-only: what is true right now, including whether asking is even on the table. */
  async inspectOwnMachine(userId: string): Promise<MachineAccessOutcome> {
    const located = await this.locate(userId);
    if ('kind' in located) return located;

    const memberships = await organizationRepository.listForUser(userId);
    if (memberships.some((m) => m.org.id === located.orgId)) {
      return { kind: 'already-visible', deviceName: located.deviceName, orgId: located.orgId };
    }

    if (await machineAccessRepository.isGranted(userId, located.deviceId)) {
      return {
        kind: 'granted',
        deviceName: located.deviceName,
        deviceId: located.deviceId,
        orgName: located.orgName,
      };
    }

    const previous = await machineAccessRepository.latestFor(userId, located.deviceId);
    if (previous?.status === 'pending') {
      return { kind: 'pending', deviceName: located.deviceName, orgName: located.orgName };
    }
    if (previous?.status === 'denied') {
      return { kind: 'denied', deviceName: located.deviceName, orgName: located.orgName };
    }
    return { kind: 'can-ask', deviceName: located.deviceName, orgName: located.orgName };
  }

  /**
   * File the request. Called only after the person has said, in words, that they want it.
   *
   * Safe to call twice: an open request is returned as-is rather than duplicated (the partial unique
   * index), and a refusal is reported rather than quietly re-asked — a no is an answer.
   */
  async askForOwnMachine(userId: string): Promise<MachineAccessOutcome> {
    const standing = await this.inspectOwnMachine(userId);
    if (standing.kind !== 'can-ask') return standing;

    const located = await this.locate(userId);
    // `inspectOwnMachine` just walked the same path and got past every early return, so anything other
    // than a located machine here is a race with a device being unpaired mid-turn.
    if ('kind' in located) return located;

    const asker = await userRepository.findById(userId);
    if (asker === undefined) throw new NotFoundError('User not found');

    const request = await machineAccessRepository.open({
      orgId: located.orgId,
      deviceId: located.deviceId,
      deviceName: located.deviceName,
      bridgeDeviceId: located.bridgeDeviceId,
      userId,
      userName: asker.display_name,
      hostname: located.hostname,
      hostId: located.hostId,
    });
    logger.info('machine access: requested', {
      requestId: request.id,
      orgId: located.orgId,
      deviceId: located.deviceId,
      userId,
    });
    await auditWriter.write({
      userId,
      action: 'propose',
      resourceType: 'system',
      resourceId: located.deviceId,
      summary: `You asked ${located.orgName} for permission to see "${located.deviceName}" — the machine your Stewra Bridge runs on.`,
      success: true,
      metadata: { orgId: located.orgId, deviceId: located.deviceId, requestId: request.id },
    });
    return { kind: 'asked', deviceName: located.deviceName, orgName: located.orgName };
  }

  /** Every request against this org's machines. Viewer. */
  async list(actor: OrgActor): Promise<ListMachineAccessRequestsResponse> {
    return { requests: await machineAccessRepository.listByOrg(actor.orgId) };
  }

  /** Approve or refuse one. Admin. */
  async decide(
    actor: OrgActor,
    requestId: string,
    body: DecideMachineAccessRequest,
  ): Promise<DecideMachineAccessResponse> {
    const decided = await machineAccessRepository.decide(
      actor.orgId,
      requestId,
      body.approve,
      actor.userId,
    );
    if (decided === null) {
      // Either it is not this org's request, or somebody already answered it. Both are 409s rather than a
      // silent no-op, because an admin who clicks Approve and is told nothing will assume it worked.
      throw new ConflictError('That request has already been decided, or does not belong to this organization');
    }
    await auditWriter.write({
      userId: actor.userId,
      action: body.approve ? 'connect' : 'dismiss',
      resourceType: 'system',
      resourceId: decided.deviceId,
      summary: body.approve
        ? `You let ${decided.requestedByName} see "${decided.deviceName}" from their Stewra Bridge.`
        : `You refused ${decided.requestedByName} sight of "${decided.deviceName}".`,
      success: true,
      metadata: { orgId: actor.orgId, deviceId: decided.deviceId, requestId: decided.id },
    });
    return { request: decided };
  }

  /** Machines outside this person's own orgs that they have been granted sight of. */
  async grantedDeviceIds(userId: string): Promise<readonly string[]> {
    return machineAccessRepository.grantedDeviceIds(userId);
  }

  /** The open requests an admin still owes an answer to, for a badge or a banner. */
  async pendingCount(orgId: string): Promise<number> {
    const requests: readonly MachineAccessRequest[] = await machineAccessRepository.listByOrg(orgId);
    return requests.filter((r) => r.status === 'pending').length;
  }
}

export const machineAccessService = new MachineAccessService();
