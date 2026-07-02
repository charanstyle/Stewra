import type { ColumnType, Generated } from 'kysely';
import type {
  AuditAction,
  AuditResourceType,
  ProcessDomain,
  ProcessDimension,
  ProcessRuleSource,
  ProcessRuleStatus,
  ProcessTier,
  Rating,
  ResourceKind,
  UserRole,
} from '@stewra/shared-types';

/** Minimized, non-sensitive structured context stored on an audit row. */
export type AuditMetadata = Record<string, string | number | boolean | null>;

/** Generated-on-insert timestamp: never written by the app, always read as a Date. */
type CreatedAt = ColumnType<Date, never, never>;

export interface UsersTable {
  id: Generated<string>;
  email: string;
  display_name: string;
  password_hash: string;
  role: UserRole;
  /** Email-ownership flag. DB default false; flipped true when the user enters their code. */
  email_verified: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, never, Date>;
}

export interface AuditLogTable {
  id: Generated<string>;
  /** Null ONLY for pre-auth/system events that have no user. */
  user_id: string | null;
  action: AuditAction;
  resource_type: AuditResourceType;
  /** Null ONLY when the event concerns no specific resource. */
  resource_id: string | null;
  summary: string;
  success: boolean;
  /** jsonb: written as a JSON string, read back as a parsed object. */
  metadata: ColumnType<AuditMetadata, string, string>;
  created_at: CreatedAt;
}

export interface ConnectionsTable {
  id: Generated<string>;
  user_id: string;
  provider: string;
  /** Which connected account this row is (e.g. a specific Gmail address); '' when not applicable. */
  account_email: ColumnType<string, string | undefined, string>;
  /** Handle into the vault. The actual token NEVER lives in this table. */
  vault_ref: string;
  status: string;
  created_at: CreatedAt;
}

export interface UserPreferencesTable {
  user_id: string;
  gmail_lookback_days: number;
  // Opt-in switch for the Sent-mail style observer. Has a DB default of false (migration 011), so it
  // is optional on insert (the default fills it when omitted) and settable on update.
  learn_from_sent_mail: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, never, Date>;
}

/**
 * One row per insight the agent produces. Gives each insight a stable id (so feedback can attach to
 * it) and records the trajectory — the purpose, the advice, and the model that produced it — which
 * is what a positive rating later turns into a reusable exemplar. `purpose_norm` is the normalized
 * purpose used by lexical recall. `facts_used` is reserved for richer trajectory capture (the
 * derived facts that fed the model); null until we plumb it through the control plane.
 */
export interface AgentInsightsTable {
  id: Generated<string>;
  user_id: string;
  kind: ResourceKind;
  purpose: string;
  purpose_norm: string;
  summary: string;
  /** The model id that produced the advice ('' for claude_cli, which uses the user's own default). */
  model_id: string;
  /** jsonb array of derived-fact strings, or null. Reserved; not populated yet. */
  facts_used: ColumnType<ReadonlyArray<string> | null, string | null, string | null>;
  /** When the insight was first surfaced to the user (first-write-wins impression). Null until seen. */
  seen_at: ColumnType<Date | null, Date | null, Date | null>;
  /** When the user dismissed the insight without rating it. Null until dismissed. */
  dismissed_at: ColumnType<Date | null, Date | null, Date | null>;
  created_at: CreatedAt;
}

/**
 * One row per (user, insight) feedback. `rating` is the 5-level verdict; `reward_score` is the
 * derived scalar (RATING_REWARD) stored for analytics; `comment` is the optional free-text. Upserted
 * on the unique (user_id, insight_id) — the latest verdict wins.
 */
export interface InsightFeedbackTable {
  id: Generated<string>;
  user_id: string;
  insight_id: string;
  rating: Rating;
  reward_score: number;
  comment: string | null;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, never, Date>;
}

/**
 * A user-owned, named, searchable learning derived from feedback. `label` is the human-meaningful
 * name; `exemplar` is "what good looks like"; `guidance` is "how to do it" (from free-text). The
 * generated `search_vector` tsvector column exists in the DB but is intentionally absent here — the
 * app never reads or writes it directly; lexical recall references it via raw SQL fragments.
 */
export interface AgentMemoryTable {
  id: Generated<string>;
  user_id: string;
  label: string;
  kind: ResourceKind;
  purpose: string;
  purpose_norm: string;
  exemplar: string;
  guidance: string | null;
  rating: Rating;
  reward_score: number;
  source: Generated<'feedback' | 'user_edited'>;
  source_insight_id: string | null;
  visible: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, never, Date>;
}

/**
 * A user-owned, generalized process/style rule — *how* the user likes work done, never the content
 * (memory-and-learning.md §1 derived-facts tier). Mirrors `agent_memory`'s trust machinery but keyed
 * by (user, domain, dimension, subject) rather than a source insight. `subject_vault_ref` holds the
 * vault handle for an `identifying`-tier contact; the plaintext contact never lives here. The
 * generated `search_vector` tsvector exists in the DB but is intentionally absent here — recall
 * references it via raw SQL fragments (same pattern as `agent_memory`).
 */
export interface ProcessMemoryTable {
  id: Generated<string>;
  user_id: string;
  domain: ProcessDomain;
  dimension: ProcessDimension;
  rule: string;
  tier: Generated<ProcessTier>;
  /** Role a `relational` rule refers to (e.g. 'manager'); null otherwise. */
  subject_role: string | null;
  /** Vault handle for an `identifying`-tier contact; null otherwise. Never a plaintext contact. */
  subject_vault_ref: string | null;
  status: Generated<ProcessRuleStatus>;
  source: Generated<ProcessRuleSource>;
  confidence: Generated<number>;
  support_count: Generated<number>;
  reward_score: Generated<number>;
  /** Source provider a rule was derived from (e.g. 'google'); enables forget-on-disconnect. */
  derived_from_provider: string | null;
  visible: Generated<boolean>;
  last_reinforced_at: ColumnType<Date | null, Date | null, Date | null>;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, never, Date>;
}

export interface MigrationsTable {
  name: string;
  applied_at: CreatedAt;
}

export interface VaultSecretsTable {
  id: Generated<string>;
  /** AES-256-GCM envelope: base64(iv).base64(authTag).base64(ciphertext). Never plaintext. */
  ciphertext: string;
  created_at: CreatedAt;
}

export interface EmailVerificationCodesTable {
  id: Generated<string>;
  user_id: string;
  /** The numeric code the user must enter. */
  code: string;
  /** Address the code was emailed to (snapshot at issue time). */
  email: string;
  /** Set on insert, read back; never updated. */
  expires_at: ColumnType<Date, Date, never>;
  /** DB default false; flipped true once the code is consumed. */
  used: ColumnType<boolean, boolean | undefined, boolean>;
  /** DB default 0; incremented on each failed entry until the lockout cap. */
  attempts: ColumnType<number, number | undefined, number>;
  created_at: CreatedAt;
}

export interface Database {
  users: UsersTable;
  audit_log: AuditLogTable;
  connections: ConnectionsTable;
  user_preferences: UserPreferencesTable;
  migrations: MigrationsTable;
  vault_secrets: VaultSecretsTable;
  email_verification_codes: EmailVerificationCodesTable;
  agent_insights: AgentInsightsTable;
  insight_feedback: InsightFeedbackTable;
  agent_memory: AgentMemoryTable;
  process_memory: ProcessMemoryTable;
}
