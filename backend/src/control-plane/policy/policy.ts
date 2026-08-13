import type { ResourceKind } from '@stewra/shared-types';
import { db } from '../../database/index.js';

/** A deterministic allow/deny decision. The model is NEVER consulted here. */
export interface PolicyDecision {
  readonly allowed: boolean;
  readonly reason: string;
}

/** Maps a resource kind to the connection provider that authorizes reading it. */
export const KIND_TO_PROVIDER: Readonly<Record<ResourceKind, string>> = {
  calendar: 'google',
  gmail: 'google',
  money: 'aggregator',
  memory: 'memory',
};

/**
 * The policy engine: deterministic, outside the model's reach, cannot be widened by the agent.
 * A user may read a resource only if they hold an active connection authorizing it. With nothing
 * connected (the M0 state) every data read is denied — which is correct: read-first, smallest
 * blast radius, and nothing to read until the user grants a connection.
 */
export class PolicyEngine {
  async canRead(userId: string, kind: ResourceKind): Promise<PolicyDecision> {
    // The global kill switch outranks every connection: while the user has paused Stewra, no data
    // read is permitted at all — checked here, at the single choke point every brokered read passes
    // through, so pausing is instant and cannot be forgotten by a caller. Read directly (not via the
    // preferences service) to keep the policy engine deterministic and dependency-light.
    const paused = await db
      .selectFrom('user_preferences')
      .select('pause_all')
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (paused?.pause_all === true) {
      return { allowed: false, reason: 'Stewra is paused — resume it in Settings to allow reads' };
    }

    const provider = KIND_TO_PROVIDER[kind];
    const connection = await db
      .selectFrom('connections')
      .select('id')
      .where('user_id', '=', userId)
      .where('provider', '=', provider)
      .where('status', '=', 'active')
      .executeTakeFirst();

    if (!connection) {
      return { allowed: false, reason: `no active ${kind} connection for this user` };
    }
    return { allowed: true, reason: 'active connection present' };
  }
}

export const policyEngine = new PolicyEngine();
