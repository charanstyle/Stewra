import type { UUID } from '../common/base';
import type {
  ProcessRule,
  ProcessDomain,
  ProcessDimension,
  ProcessRuleStatus,
} from '../models/processRule';

/** List the user's process/style rules, optionally filtered by domain, status, or a lexical search. */
export interface ListProcessRulesRequest {
  readonly domain?: ProcessDomain;
  readonly status?: ProcessRuleStatus;
  readonly search?: string;
}

export interface ListProcessRulesResponse {
  readonly rules: ReadonlyArray<ProcessRule>;
}

/**
 * Create a rule the user states directly. A user-stated rule is `active` immediately (they said it).
 * `subjectRole` is only meaningful for the `recipients` dimension; a concrete contact identity is
 * never accepted here — the server only ever stores a role or a vault handle it derives itself.
 */
export interface CreateProcessRuleRequest {
  readonly domain: ProcessDomain;
  readonly dimension: ProcessDimension;
  readonly rule: string;
  readonly subjectRole?: string | null;
}

export interface CreateProcessRuleResponse {
  readonly rule: ProcessRule;
}

/**
 * Edit a rule the user owns. `rule` revises the text; `status` confirms a proposal (`active`),
 * mutes it (`muted`), or re-proposes; `visible` toggles eligibility for recall. Any subset may be sent.
 */
export interface UpdateProcessRuleRequest {
  readonly rule?: string;
  readonly status?: ProcessRuleStatus;
  readonly visible?: boolean;
}

export interface UpdateProcessRuleResponse {
  readonly rule: ProcessRule;
}

export interface DeleteProcessRuleResponse {
  readonly id: UUID;
}
