import type { ISODateString, UUID } from '../common/base';

/**
 * A bridge asking to see the machine it is already running on.
 *
 * The situation this exists for is narrow and real. Bridge devices are USER-scoped; runner devices are
 * ORG-scoped. So a Stewra Bridge can sit on the very computer a runner is paired from and still be unable
 * to answer "what's running here?" — not because anything is broken, but because the two belong to
 * different tenants. Before this, the conversation ended at "I don't have a machine called that", with no
 * route from the dead end to permission.
 *
 * WHAT APPROVAL GRANTS, exactly: the bridge's user may SEE that one machine — is it up, what is running on
 * it, what has run. It does not make them a member of the org, does not reach any other machine in it, and
 * does NOT let them start a session. Running an agent on someone else's machine, in someone else's
 * repositories, is a different question from being told the machine is idle, and it stays behind org
 * membership where it belongs.
 */
export type MachineAccessStatus = 'pending' | 'approved' | 'denied';

export interface MachineAccessRequest {
  readonly id: UUID;
  /** The org that owns the runner device — the tenant whose admins decide. */
  readonly orgId: UUID;
  /** The runner device being asked about. */
  readonly deviceId: UUID;
  /** The machine's name in that org, snapshotted so a decided request still reads sensibly. */
  readonly deviceName: string;
  /** Who is asking: the person the bridge is paired to. */
  readonly requestedByUserId: UUID;
  /** Their display name, snapshotted for the same reason. */
  readonly requestedByName: string;
  /** What the machine calls itself — shown so an approver can recognise their own computer. */
  readonly hostname: string;
  readonly status: MachineAccessStatus;
  readonly requestedAt: ISODateString;
  /** When someone decided. Null while pending. */
  readonly decidedAt: ISODateString | null;
}
