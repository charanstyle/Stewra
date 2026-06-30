import { AgentRuntime } from '@stewra/agent-runtime';
import { broker } from '../control-plane/broker/broker';
import { modelClient } from './modelClient';

/**
 * The ONE place the two planes meet: the control-plane broker (trusted, holds db/vault/policy) and
 * the model client are injected into the untrusted AgentRuntime. The runtime receives only these
 * two capabilities — never the db, the vault, or a network client. This wiring is the entire trust
 * boundary, expressed in a single file.
 */
export const agentRuntime = new AgentRuntime(broker, modelClient);
