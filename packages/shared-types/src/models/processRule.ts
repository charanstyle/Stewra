import type { ISODateString, UUID } from '../common/base';
import type { ResourceKind } from '../broker/contract';

/**
 * Process & style memory — a user-owned rule capturing *how* the user likes work done (the
 * "process"), never *what* the work was (the content). E.g. "Opens warm, then states the ask within
 * two sentences." This is the derived-facts / profile tier from memory-and-learning.md §1, distinct
 * from the task-scoped exemplars in `AgentMemory`.
 */

/** The area of work a rule governs. `email` is the active domain; the rest generalize the mechanism. */
export type ProcessDomain = 'email' | 'advice' | 'inbox' | 'calendar';

/**
 * Which process/style DOMAIN a task over a given connected resource kind is shaped by — the single
 * source of truth shared by the runtime (which profile to inject) and the feedback path (which
 * domain a rated insight's comment teaches). A gmail task follows the user's `email` style; a
 * calendar task their `calendar` style. Kinds absent here (e.g. `money`, `memory`) have no style
 * domain, so there is simply nothing to shape or learn.
 */
export const KIND_TO_PROCESS_DOMAIN: Partial<Record<ResourceKind, ProcessDomain>> = {
  gmail: 'email',
  calendar: 'calendar',
};

/**
 * The process axis a rule speaks to (a small controlled vocabulary, not free-form). `proofreading`
 * and revision-style dimensions are only observable once drafting ships (trust-ladder Stage 2) —
 * they exist here so the schema is ready, but stay dormant until then.
 */
export type ProcessDimension =
  | 'tone'
  | 'length'
  | 'structure'
  | 'salutation'
  | 'signoff'
  | 'recipients'
  | 'proofreading'
  | 'timing'
  | 'do_not';

/**
 * Sensitivity tier. `style` references no entities (pure "how"). `relational` references a ROLE
 * ("my manager"), never an identity. `identifying` references a concrete person whose value can't be
 * generalized — that value lives in the vault, never on the rule row.
 */
export type ProcessTier = 'style' | 'relational' | 'identifying';

/** `proposed` awaits the user's OK; `active` is applied on recall; `muted` is kept but not applied. */
export type ProcessRuleStatus = 'proposed' | 'active' | 'muted';

/** How the rule came to exist. The model may only produce `observed`/`feedback` candidates (never silent). */
export type ProcessRuleSource = 'stated' | 'feedback' | 'observed' | 'user_edited';

/**
 * A user-owned process/style rule. Fully visible, editable, and deletable by the user
 * (memory-and-learning.md §5). The vault handle backing an `identifying` rule is intentionally NOT
 * part of this model — clients see the tier and (for `relational`) the role, never a raw contact.
 */
export interface ProcessRule {
  readonly id: UUID;
  readonly domain: ProcessDomain;
  readonly dimension: ProcessDimension;
  /** The generalized "how", in plain language. */
  readonly rule: string;
  readonly tier: ProcessTier;
  /** The role a `relational` rule refers to (e.g. 'manager'); null for `style`/`identifying`. */
  readonly subjectRole: string | null;
  readonly status: ProcessRuleStatus;
  readonly source: ProcessRuleSource;
  /** 0..100 — grows with corroborating evidence and positive outcomes. */
  readonly confidence: number;
  /** How many independent observations back this rule (a count, never the content). */
  readonly supportCount: number;
  /** Sutton reward accumulated under this rule (same scale as feedback RATING_REWARD). */
  readonly rewardScore: number;
  readonly visible: boolean;
  readonly createdAt: ISODateString;
  readonly updatedAt: ISODateString;
}
