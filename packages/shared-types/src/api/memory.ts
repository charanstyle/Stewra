import type { UUID } from '../common/base';
import type { ResourceKind } from '../broker/contract';
import type { AgentMemory } from '../models/memory';

/** List the user's memories, optionally filtered by a lexical `search` and/or `kind`. */
export interface ListMemoriesRequest {
  readonly search?: string;
  readonly kind?: ResourceKind;
}

export interface ListMemoriesResponse {
  readonly memories: ReadonlyArray<AgentMemory>;
}

/**
 * Edit a memory the user owns. Any subset of fields may be sent. `label` stays the searchable name;
 * `guidance` may be cleared by sending null; `visible` toggles whether it's eligible for recall.
 */
export interface UpdateMemoryRequest {
  readonly label?: string;
  readonly guidance?: string | null;
  readonly visible?: boolean;
}

export interface UpdateMemoryResponse {
  readonly memory: AgentMemory;
}

export interface DeleteMemoryResponse {
  readonly id: UUID;
}
