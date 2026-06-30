import type { UUID } from '../common/base';

/**
 * The single brokered-access contract. The agent runtime (untrusted data plane) NEVER touches
 * the database, the vault, or the network. It asks the broker for a task-scoped, policy-permitted,
 * minimized slice of data and gets back only that. The same path serves raw-data reads today and
 * memory slices later — there is intentionally no second access path.
 */

/** Kinds of resource the broker can be asked for. `memory` reserved for post-M1/M2. */
export type ResourceKind = 'calendar' | 'gmail' | 'money' | 'memory';

/** What the agent is allowed to ask the broker for. */
export interface BrokerRequest {
  /** The user whose data is in scope. */
  readonly userId: UUID;
  /** The kind of resource requested. */
  readonly kind: ResourceKind;
  /** A short, human-meaningful label for why this slice is needed (for the audit log). */
  readonly purpose: string;
  /** Bounded parameters (e.g. a date window); always present, `{}` when none. Never credentials. */
  readonly params: Readonly<Record<string, string | number | boolean>>;
}

/**
 * What the broker returns: a minimized, policy-permitted result — or a denial. The data is always
 * a list of short DERIVED FACTS (e.g. "protects Thursday evenings"), never raw records. Raw data
 * never crosses this boundary, so it never reaches the model (memory-and-learning.md §1/§2).
 */
export type BrokerResult =
  | { readonly allowed: true; readonly kind: ResourceKind; readonly facts: ReadonlyArray<string> }
  | { readonly allowed: false; readonly kind: ResourceKind; readonly reason: string };

/**
 * The ONLY capability the agent runtime has to obtain data. Implemented in the control plane
 * (with db + vault + policy + audit) and injected into the agent. The agent depends on this
 * interface, never on a concrete implementation.
 */
export interface IBrokerClient {
  request(req: BrokerRequest): Promise<BrokerResult>;
}

/** A single message exchanged with the model. */
export interface ModelMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

/**
 * The model interface, injected into the agent. Swappable behind one interface (no hardcoded
 * vendor). In M0 the concrete impl is a deterministic stub so the agent loop runs without a key.
 */
export interface IModelClient {
  complete(messages: ReadonlyArray<ModelMessage>): Promise<string>;
}

/** An insight produced by the agent — advice only, never an action (read-first product). */
export interface AgentInsight {
  readonly kind: ResourceKind;
  readonly summary: string;
}
