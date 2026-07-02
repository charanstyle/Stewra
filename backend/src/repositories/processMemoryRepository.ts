import type {
  ProcessRule,
  ProcessDomain,
  ProcessDimension,
  ProcessRuleSource,
  ProcessRuleStatus,
  ProcessTier,
} from '@stewra/shared-types';
import { sql } from 'kysely';
import { db } from '../database/index';

/** The columns that reconstruct a client-facing `ProcessRule` (never the vault ref or provider). */
const MODEL_COLUMNS = [
  'id',
  'domain',
  'dimension',
  'rule',
  'tier',
  'subject_role',
  'status',
  'source',
  'confidence',
  'support_count',
  'reward_score',
  'visible',
  'created_at',
  'updated_at',
] as const;

interface ProcessRuleRow {
  readonly id: string;
  readonly domain: ProcessDomain;
  readonly dimension: ProcessDimension;
  readonly rule: string;
  readonly tier: ProcessTier;
  readonly subject_role: string | null;
  readonly status: ProcessRuleStatus;
  readonly source: ProcessRuleSource;
  readonly confidence: number;
  readonly support_count: number;
  readonly reward_score: number;
  readonly visible: boolean;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** Everything the runtime recall step needs to render a style-profile line (never a raw contact). */
export interface RecalledRule {
  readonly dimension: ProcessDimension;
  readonly rule: string;
  readonly subjectRole: string | null;
}

export interface InsertProcessRuleInput {
  readonly userId: string;
  readonly domain: ProcessDomain;
  readonly dimension: ProcessDimension;
  readonly rule: string;
  readonly tier: ProcessTier;
  /** Role a `relational` rule refers to (e.g. 'manager'); null otherwise. */
  readonly subjectRole: string | null;
  /** Vault handle for an `identifying` rule; null otherwise. Never a plaintext contact. */
  readonly subjectVaultRef: string | null;
  readonly status: ProcessRuleStatus;
  readonly source: ProcessRuleSource;
  /** Source provider the rule was derived from (e.g. 'google'); enables forget-on-disconnect. */
  readonly derivedFromProvider: string | null;
  readonly confidence?: number;
  readonly supportCount?: number;
  readonly rewardScore?: number;
}

/** The fields a user may edit on a rule they own. Any subset may be provided. */
export interface UpdateProcessRulePatch {
  readonly rule?: string;
  readonly status?: ProcessRuleStatus;
  readonly visible?: boolean;
}

/**
 * A capture-driven refresh of the rule already occupying an axis. Unlike the user-facing `update`,
 * this also rewrites provenance — `source` and `derived_from_provider` — so that e.g. a user
 * restating an `observed` rule flips it to user-owned (`stated`, no provider) and thus survives
 * forget-on-disconnect. Counter reinforcement (support/confidence/reward) is applied separately by
 * `reinforceActiveForDomain`, driven by rated feedback.
 */
export interface ReconcileAxisPatch {
  readonly rule: string;
  readonly status: ProcessRuleStatus;
  readonly source: ProcessRuleSource;
  readonly derivedFromProvider: string | null;
  /** The candidate's tier — lets a generic `style` axis be upgraded to `relational`/`identifying`. */
  readonly tier: ProcessTier;
  /** Vault handle for an `identifying` rule; null otherwise. Rewritten so an upgraded axis is honest. */
  readonly subjectVaultRef: string | null;
}

export interface ListProcessRuleFilters {
  readonly domain?: ProcessDomain;
  readonly status?: ProcessRuleStatus;
  readonly search?: string;
}

export function toProcessRuleModel(row: ProcessRuleRow): ProcessRule {
  return {
    id: row.id,
    domain: row.domain,
    dimension: row.dimension,
    rule: row.rule,
    tier: row.tier,
    subjectRole: row.subject_role,
    status: row.status,
    source: row.source,
    confidence: row.confidence,
    supportCount: row.support_count,
    rewardScore: row.reward_score,
    visible: row.visible,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Data access for the process/style store. Keyed by the (user, domain, dimension, subject_role) axis
 * rather than a source insight — one rule per axis (enforced by `uq_process_memory_user_axis`, which
 * COALESCEs the nullable role). The service layer decides *when* to insert vs. refresh an axis so the
 * "model never writes an active rule silently" rule (memory-and-learning.md §3) lives in one place;
 * this repo just executes. `subject_vault_ref` and `derived_from_provider` are written but never
 * surfaced in the client model — same reason `agent_memory` hides its search_vector.
 */
export class ProcessMemoryRepository {
  /** Insert a brand-new rule for an axis. Throws on the unique axis if one already exists. */
  async insert(input: InsertProcessRuleInput): Promise<ProcessRule> {
    const row = await db
      .insertInto('process_memory')
      .values({
        user_id: input.userId,
        domain: input.domain,
        dimension: input.dimension,
        rule: input.rule,
        tier: input.tier,
        subject_role: input.subjectRole,
        subject_vault_ref: input.subjectVaultRef,
        status: input.status,
        source: input.source,
        derived_from_provider: input.derivedFromProvider,
        ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
        ...(input.supportCount !== undefined ? { support_count: input.supportCount } : {}),
        ...(input.rewardScore !== undefined ? { reward_score: input.rewardScore } : {}),
      })
      .returning(MODEL_COLUMNS)
      .executeTakeFirstOrThrow();
    return toProcessRuleModel(row);
  }

  /**
   * Fetch the single rule occupying an axis, if any — the lookup the service uses to decide whether a
   * candidate is new, corroborates an existing rule, or must not clobber a user-confirmed one. A null
   * role matches only the role-less (`style`) row for that axis, mirroring the unique index's COALESCE.
   */
  async findByAxis(
    userId: string,
    domain: ProcessDomain,
    dimension: ProcessDimension,
    subjectRole: string | null,
  ): Promise<ProcessRule | undefined> {
    const row = await db
      .selectFrom('process_memory')
      .select(MODEL_COLUMNS)
      .where('user_id', '=', userId)
      .where('domain', '=', domain)
      .where('dimension', '=', dimension)
      .where(sql<boolean>`coalesce(subject_role, '') = coalesce(${subjectRole}, '')`)
      .executeTakeFirst();
    return row ? toProcessRuleModel(row) : undefined;
  }

  /**
   * The style profile to inject when shaping a task: the user's `active`, `visible` rules for a
   * domain, strongest first (confidence, then accumulated reward, then most recently touched). Bounded
   * by `limit` (config) so the profile can't balloon the prompt. Proposed/muted rules are excluded —
   * only rules the user has (implicitly or explicitly) accepted shape output.
   */
  async recallForDomain(
    userId: string,
    domain: ProcessDomain,
    limit: number,
  ): Promise<ReadonlyArray<RecalledRule>> {
    return db
      .selectFrom('process_memory')
      .select(['dimension', 'rule', 'subject_role as subjectRole'])
      .where('user_id', '=', userId)
      .where('domain', '=', domain)
      .where('status', '=', 'active')
      .where('visible', '=', true)
      .orderBy('confidence', 'desc')
      .orderBy('reward_score', 'desc')
      .orderBy('updated_at', 'desc')
      .limit(limit)
      .execute();
  }

  /** List the user's rules for the Memory screen, newest first, with optional filters. */
  async list(userId: string, filters: ListProcessRuleFilters): Promise<ReadonlyArray<ProcessRule>> {
    let q = db.selectFrom('process_memory').select(MODEL_COLUMNS).where('user_id', '=', userId);
    if (filters.domain) {
      q = q.where('domain', '=', filters.domain);
    }
    if (filters.status) {
      q = q.where('status', '=', filters.status);
    }
    if (filters.search && filters.search.trim().length > 0) {
      q = q.where(sql<boolean>`search_vector @@ websearch_to_tsquery('english', ${filters.search})`);
    }
    const rows = await q.orderBy('updated_at', 'desc').execute();
    return rows.map(toProcessRuleModel);
  }

  async findByIdForUser(id: string, userId: string): Promise<ProcessRule | undefined> {
    const row = await db
      .selectFrom('process_memory')
      .select(MODEL_COLUMNS)
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row ? toProcessRuleModel(row) : undefined;
  }

  /**
   * Refresh the rule on an axis from a new capture (text + status + provenance). Used by the service's
   * capture path when a candidate lands on an axis that already exists. Scoped to the owner.
   */
  async reconcileAxis(id: string, userId: string, patch: ReconcileAxisPatch): Promise<ProcessRule> {
    const row = await db
      .updateTable('process_memory')
      .set({
        rule: patch.rule,
        status: patch.status,
        source: patch.source,
        derived_from_provider: patch.derivedFromProvider,
        tier: patch.tier,
        subject_vault_ref: patch.subjectVaultRef,
        updated_at: sql`now()`,
      })
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .returning(MODEL_COLUMNS)
      .executeTakeFirstOrThrow();
    return toProcessRuleModel(row);
  }

  /**
   * Read the vault handle currently stored on an axis (or null if the row has none / does not exist).
   * Kept separate from the client model — `subject_vault_ref` is never surfaced there — so the observer
   * can reuse an existing handle for a recurring contact instead of stacking duplicate encrypted copies.
   */
  async findVaultRefByAxis(
    userId: string,
    domain: ProcessDomain,
    dimension: ProcessDimension,
    subjectRole: string | null,
  ): Promise<string | null> {
    const row = await db
      .selectFrom('process_memory')
      .select('subject_vault_ref')
      .where('user_id', '=', userId)
      .where('domain', '=', domain)
      .where('dimension', '=', dimension)
      .where(sql<boolean>`coalesce(subject_role, '') = coalesce(${subjectRole}, '')`)
      .executeTakeFirst();
    return row?.subject_vault_ref ?? null;
  }

  /**
   * Reinforce the rules that shaped a domain's advice after the user rates the result (the Sutton
   * reward step). Applies to exactly the `active`, `visible` rules the recall step would have injected
   * — same filter and ordering, same `limit` — so credit lands on the rules that were actually used.
   * `rewardDelta` accrues the raw signed reward; `confidenceDelta` nudges confidence (clamped 0..100);
   * `supportDelta` counts a positive rating as another corroborating observation. Touches
   * `last_reinforced_at`. Returns how many rules were reinforced. Pure counter movement — no row is
   * created, deleted, or has its text/status changed, so it never conflicts with the §3 clobber rule.
   */
  async reinforceActiveForDomain(
    userId: string,
    domain: ProcessDomain,
    limit: number,
    rewardDelta: number,
    confidenceDelta: number,
    supportDelta: number,
  ): Promise<number> {
    const result = await db
      .updateTable('process_memory')
      .set({
        reward_score: sql`reward_score + ${rewardDelta}`,
        confidence: sql`least(100, greatest(0, confidence + ${confidenceDelta}))`,
        support_count: sql`support_count + ${supportDelta}`,
        last_reinforced_at: sql`now()`,
        updated_at: sql`now()`,
      })
      .where(
        'id',
        'in',
        db
          .selectFrom('process_memory')
          .select('id')
          .where('user_id', '=', userId)
          .where('domain', '=', domain)
          .where('status', '=', 'active')
          .where('visible', '=', true)
          .orderBy('confidence', 'desc')
          .orderBy('reward_score', 'desc')
          .orderBy('updated_at', 'desc')
          .limit(limit),
      )
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  /** Apply a partial edit the user owns. Only provided fields change (conditional set). */
  async update(id: string, userId: string, patch: UpdateProcessRulePatch): Promise<ProcessRule> {
    const row = await db
      .updateTable('process_memory')
      .set({
        updated_at: sql`now()`,
        ...(patch.rule !== undefined ? { rule: patch.rule } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.visible !== undefined ? { visible: patch.visible } : {}),
      })
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .returning(MODEL_COLUMNS)
      .executeTakeFirstOrThrow();
    return toProcessRuleModel(row);
  }

  /** Real delete (memory-and-learning.md §5 — no soft-delete). Returns whether a row was removed. */
  async delete(id: string, userId: string): Promise<boolean> {
    const result = await db
      .deleteFrom('process_memory')
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  /**
   * The vault handles held by the provider-derived rules in a domain — read BEFORE deleting those
   * rows so the caller can purge the referenced encrypted contacts from the vault too (an
   * `identifying` rule's `subject_vault_ref` would otherwise be orphaned on forget-on-disconnect).
   * Only non-null handles are returned. Scoped exactly like `deleteByProviderDomain`.
   */
  async vaultRefsByProviderDomain(
    userId: string,
    provider: string,
    domain: ProcessDomain,
  ): Promise<ReadonlyArray<string>> {
    const rows = await db
      .selectFrom('process_memory')
      .select('subject_vault_ref')
      .where('user_id', '=', userId)
      .where('derived_from_provider', '=', provider)
      .where('domain', '=', domain)
      .where('subject_vault_ref', 'is not', null)
      .execute();
    return rows.map((r) => r.subject_vault_ref).filter((ref): ref is string => ref !== null);
  }

  /**
   * Forget-on-disconnect: purge the rules a user built from a source they just revoked (rows tagged
   * with `derived_from_provider`) within one domain. Scoped by domain because a provider can feed
   * several domains via different kinds, and a domain is forgotten only once no active connection
   * still authorizes its kind. User-`stated`/`user_edited` rules carry no provider, so they're
   * untouched. Returns how many were removed.
   */
  async deleteByProviderDomain(
    userId: string,
    provider: string,
    domain: ProcessDomain,
  ): Promise<number> {
    const result = await db
      .deleteFrom('process_memory')
      .where('user_id', '=', userId)
      .where('derived_from_provider', '=', provider)
      .where('domain', '=', domain)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }
}

export const processMemoryRepository = new ProcessMemoryRepository();
