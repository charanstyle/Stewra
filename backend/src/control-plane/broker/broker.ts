import type { BrokerRequest, BrokerResult, IBrokerClient } from '@stewra/shared-types';
import type { PolicyEngine} from '../policy/policy';
import { policyEngine } from '../policy/policy';
import type { AuditWriter} from '../audit/auditWriter';
import { auditWriter } from '../audit/auditWriter';
import type { ConnectionService} from '../../services/connectionService';
import { connectionService } from '../../services/connectionService';

/**
 * The broker — the single brokered-access path between the untrusted agent and the user's data.
 * For every request it: (1) asks the deterministic policy engine; (2) writes an audit row (every
 * access, allowed or denied, is logged); (3) on allow, fetches MINIMIZED DERIVED FACTS server-side
 * and returns only those. It holds the db/vault/policy; the agent holds only this object's
 * `request` method via the IBrokerClient interface. There is no second access path.
 */
export class Broker implements IBrokerClient {
  private readonly policy: PolicyEngine;
  private readonly audit: AuditWriter;
  private readonly connections: ConnectionService;

  constructor(policy: PolicyEngine, audit: AuditWriter, connections: ConnectionService) {
    this.policy = policy;
    this.audit = audit;
    this.connections = connections;
  }

  async request(req: BrokerRequest): Promise<BrokerResult> {
    const decision = await this.policy.canRead(req.userId, req.kind);

    await this.audit.write({
      userId: req.userId,
      action: 'read',
      resourceType: req.kind,
      resourceId: null,
      summary: decision.allowed
        ? `Read ${req.kind} for: ${req.purpose}`
        : `Denied ${req.kind} read for: ${req.purpose} (${decision.reason})`,
      success: decision.allowed,
      metadata: { purpose: req.purpose },
    });

    if (!decision.allowed) {
      return { allowed: false, kind: req.kind, reason: decision.reason };
    }

    const facts = await this.connections.fetchDerivedFacts(req.userId, req.kind);
    return { allowed: true, kind: req.kind, facts };
  }
}

export const broker = new Broker(policyEngine, auditWriter, connectionService);
