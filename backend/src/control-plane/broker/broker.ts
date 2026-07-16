import type {
  BrokerRequest,
  BrokerResult,
  IBrokerClient,
  ProcessDomain,
  ResourceKind,
} from '@stewra/shared-types';
import type { PolicyEngine} from '../policy/policy.js';
import { policyEngine } from '../policy/policy.js';
import type { AuditWriter} from '../audit/auditWriter.js';
import { auditWriter } from '../audit/auditWriter.js';
import type { ConnectionService} from '../../services/connectionService.js';
import { connectionService } from '../../services/connectionService.js';
import type { MemoryService } from '../../services/memoryService.js';
import { memoryService } from '../../services/memoryService.js';
import type { ProcessMemoryService } from '../../services/processMemoryService.js';
import { processMemoryService } from '../../services/processMemoryService.js';

/** The connected-source kinds a memory slice can be scoped to (memory itself is not a scope). */
type ScopeKind = Exclude<ResourceKind, 'memory'>;

function isScopeKind(value: unknown): value is ScopeKind {
  return value === 'calendar' || value === 'gmail' || value === 'money';
}

function isProcessDomain(value: unknown): value is ProcessDomain {
  return value === 'email' || value === 'advice' || value === 'inbox' || value === 'calendar';
}

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
  private readonly memory: MemoryService;
  private readonly processMemory: ProcessMemoryService;

  constructor(
    policy: PolicyEngine,
    audit: AuditWriter,
    connections: ConnectionService,
    memory: MemoryService,
    processMemory: ProcessMemoryService,
  ) {
    this.policy = policy;
    this.audit = audit;
    this.connections = connections;
    this.memory = memory;
    this.processMemory = processMemory;
  }

  async request(req: BrokerRequest): Promise<BrokerResult> {
    // Memory is the user's OWN store, not an external connected source — so it isn't gated by the
    // connection policy (which would deny it). It's always readable by its owner, still audited, and
    // still minimized to a task-scoped slice. This keeps the single brokered-access path intact.
    if (req.kind === 'memory') {
      // Two slices of the user's OWN store share this kind: past-success exemplars (the default) and
      // the process/style profile (`slice: 'profile'`) — the generalized "how they like it done".
      return req.params['slice'] === 'profile' ? this.recallProfile(req) : this.recallMemory(req);
    }

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

  /**
   * Return past-success exemplars for the task, scoped to the connected kind named in
   * `params.scopeKind`. Always allowed for the owner; every recall is audited. Returns an empty slice
   * (never a denial) when there's nothing relevant, so the agent simply proceeds without exemplars.
   */
  private async recallMemory(req: BrokerRequest): Promise<BrokerResult> {
    const scope = req.params['scopeKind'];
    await this.audit.write({
      userId: req.userId,
      action: 'read',
      resourceType: 'memory',
      resourceId: null,
      summary: `Recalled past successes for: ${req.purpose}`,
      success: true,
      metadata: { purpose: req.purpose, scopeKind: isScopeKind(scope) ? scope : '' },
    });

    if (!isScopeKind(scope)) {
      return { allowed: true, kind: 'memory', facts: [] };
    }
    const facts = await this.memory.recall(req.userId, scope, req.purpose);
    return { allowed: true, kind: 'memory', facts };
  }

  /**
   * Return the user's active process/style profile for the domain in `params.domain` — the "how they
   * like it done" rules the runtime injects into the model's system message. Like exemplar recall it's
   * always allowed for the owner (their own store), audited as a `process_profile` read, and already
   * bounded/minimized service-side. An unknown/absent domain yields an empty slice, never a denial.
   */
  private async recallProfile(req: BrokerRequest): Promise<BrokerResult> {
    const domain = req.params['domain'];
    await this.audit.write({
      userId: req.userId,
      action: 'read',
      resourceType: 'process_profile',
      resourceId: null,
      summary: `Recalled style profile for: ${req.purpose}`,
      success: true,
      metadata: { purpose: req.purpose, domain: isProcessDomain(domain) ? domain : '' },
    });

    if (!isProcessDomain(domain)) {
      return { allowed: true, kind: 'memory', facts: [] };
    }
    const facts = await this.processMemory.recall(req.userId, domain);
    return { allowed: true, kind: 'memory', facts };
  }
}

export const broker = new Broker(
  policyEngine,
  auditWriter,
  connectionService,
  memoryService,
  processMemoryService,
);
