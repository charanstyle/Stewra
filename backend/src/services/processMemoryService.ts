import type {
  ProcessRule,
  ProcessDomain,
  ProcessDimension,
  ProcessRuleSource,
  ProcessRuleStatus,
  ProcessTier,
  ResourceKind,
} from '@stewra/shared-types';
import { KIND_TO_PROCESS_DOMAIN } from '@stewra/shared-types';
import * as Sentry from '@sentry/node';
import { auditWriter } from '../control-plane/audit/auditWriter';
import { processMemoryRepository } from '../repositories/processMemoryRepository';
import type {
  ListProcessRuleFilters,
  UpdateProcessRulePatch,
} from '../repositories/processMemoryRepository';
import { connectionRepository } from '../repositories/connectionRepository';
import { policyEngine, KIND_TO_PROVIDER } from '../control-plane/policy/policy';
import { vault } from '../control-plane/vault/vault';
import { config } from '../config/unifiedConfig';
import { NotFoundError } from '../utils/errors';
import { extractProcessRuleCandidates } from '../utils/processRuleExtraction';
import { preferencesService } from './preferencesService';
import {
  fetchSentMailSamples,
  isGoogleAuthError,
  type RecurringCcContact,
} from './googleOAuthService';
import { observeSentMailStyle, type SentMailSample } from './sentMailStyleObserver';

/** What the API accepts to create a user-STATED rule (role only; concrete-identity handling is UI-driven). */
export interface CreateStatedRuleInput {
  readonly domain: ProcessDomain;
  readonly dimension: ProcessDimension;
  readonly rule: string;
  readonly subjectRole: string | null;
}

/** A candidate rule to capture. The caller (a source: stated/feedback/observed) sets status+source. */
export interface CaptureRuleInput {
  readonly domain: ProcessDomain;
  readonly dimension: ProcessDimension;
  readonly rule: string;
  readonly tier: ProcessTier;
  /** Role a `relational` rule refers to; null otherwise. */
  readonly subjectRole: string | null;
  /** Vault handle for an `identifying` rule; null otherwise. Never a plaintext contact. */
  readonly subjectVaultRef: string | null;
  readonly status: ProcessRuleStatus;
  readonly source: ProcessRuleSource;
  /** Provider a rule was derived from (e.g. 'google'); null for user-authored rules. */
  readonly derivedFromProvider: string | null;
  /** Initial confidence for a freshly-inserted rule (0..100); omitted → repo/DB default. */
  readonly confidence?: number;
  /** Initial support count for a freshly-inserted rule; omitted → repo/DB default. */
  readonly supportCount?: number;
}

/**
 * The §3 guard, as a pure predicate: a machine `proposed` candidate must never silently overwrite a
 * rule the user has already confirmed (`active`). Any other transition (new proposal, user confirming,
 * refreshing an active rule's text) is allowed. Kept pure so the invariant is unit-testable without a DB.
 */
export function isSilentClobber(
  existingStatus: ProcessRuleStatus,
  incomingStatus: ProcessRuleStatus,
): boolean {
  return existingStatus === 'active' && incomingStatus === 'proposed';
}

/**
 * The connected resource kinds that feed a process/style domain — the only kinds whose disconnect can
 * leave `observed` rules to forget. Explicit (not derived from `KIND_TO_PROCESS_DOMAIN` at runtime) so
 * the list stays typed as `ResourceKind` without an assertion; each still resolves its domain via that
 * map. Mirrors `memoryService`'s `SCOPE_KINDS`.
 */
const PROCESS_SCOPE_KINDS: ReadonlyArray<ResourceKind> = ['gmail', 'calendar'];

/** Render a snake_case role token as plain words for a recall line ("internal_colleague" → "internal colleague"). */
function humanizeRole(role: string): string {
  return role.replace(/_/g, ' ');
}

/** The counter movements one rated feedback applies to the rules that shaped the advice. */
export interface ReinforcementDeltas {
  /** Raw signed reward accrued (the RATING_REWARD scalar), positive or negative. */
  readonly rewardDelta: number;
  /** How confidence moves — up by `step` on a positive rating, down by it on a negative one. */
  readonly confidenceDelta: number;
  /** A positive rating counts as one more corroborating observation; a negative one adds none. */
  readonly supportDelta: number;
}

/**
 * The Sutton reward step as a PURE function (kept testable without a DB, like `isSilentClobber`):
 * given a rating's signed reward and the configured confidence step, decide how the rules that shaped
 * the advice should move. A positive outcome reinforces (confidence up, one more supporting
 * observation); a negative one decays (confidence down, no new support). Reward always accrues the raw
 * signed scalar so the running `reward_score` reflects net outcome. The repo clamps confidence to
 * 0..100 on write.
 */
export function reinforcementDeltas(rewardScore: number, confidenceStep: number): ReinforcementDeltas {
  const positive = rewardScore > 0;
  return {
    rewardDelta: rewardScore,
    confidenceDelta: positive ? confidenceStep : -confidenceStep,
    supportDelta: positive ? 1 : 0,
  };
}

/**
 * The user-owned process/style store — *how* the user likes work done, never the content. The control
 * plane (never the agent) writes it, mirroring `MemoryService`. Jobs:
 *  - `capture`: land a candidate rule from one of the sources (stated / feedback / observed), obeying
 *    the "model proposes, never writes an active rule silently" rule (memory-and-learning.md §3).
 *  - `recall`: return the active style profile for a domain, formatted for the model's system message.
 *  - list / update / delete / forget: keep the profile fully visible, editable, and forgettable (§5).
 */
export class ProcessMemoryService {
  /**
   * Capture a candidate rule for its (domain, dimension, subject) axis. New axis → insert. Existing
   * axis → refresh its text/status UNLESS that would silently downgrade a user-confirmed (`active`)
   * rule to a machine `proposed` one, in which case we leave the confirmed rule untouched and return
   * it (§3 — the model never overwrites the user's confirmed profile without them). Proposals are
   * audited as `propose`; anything that becomes/stays `active` is audited as `learn`. Returns the
   * resulting rule, or the untouched existing rule when a clobber was refused.
   */
  async capture(userId: string, input: CaptureRuleInput): Promise<ProcessRule> {
    const existing = await processMemoryRepository.findByAxis(
      userId,
      input.domain,
      input.dimension,
      input.subjectRole,
    );

    if (existing && isSilentClobber(existing.status, input.status)) {
      return existing;
    }

    // Idempotent no-op: a re-observation that would change nothing (same text, status, and source)
    // must not churn the row or write another audit line. This keeps the repeatedly-running Sent-mail
    // observer from spamming `propose` audits when it keeps seeing the same style.
    if (
      existing &&
      existing.rule === input.rule &&
      existing.status === input.status &&
      existing.source === input.source
    ) {
      return existing;
    }

    const rule = existing
      ? await processMemoryRepository.reconcileAxis(existing.id, userId, {
          rule: input.rule,
          status: input.status,
          source: input.source,
          derivedFromProvider: input.derivedFromProvider,
          tier: input.tier,
          subjectVaultRef: input.subjectVaultRef,
        })
      : await processMemoryRepository.insert({
          userId,
          domain: input.domain,
          dimension: input.dimension,
          rule: input.rule,
          tier: input.tier,
          subjectRole: input.subjectRole,
          subjectVaultRef: input.subjectVaultRef,
          status: input.status,
          source: input.source,
          derivedFromProvider: input.derivedFromProvider,
          ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
          ...(input.supportCount !== undefined ? { supportCount: input.supportCount } : {}),
        });

    await auditWriter.write({
      userId,
      action: input.status === 'proposed' ? 'propose' : 'learn',
      resourceType: 'process_profile',
      resourceId: rule.id,
      summary:
        input.status === 'proposed'
          ? `Proposed a ${input.domain} style rule (${input.dimension})`
          : `Learned a ${input.domain} style rule (${input.dimension})`,
      success: true,
      metadata: {
        domain: input.domain,
        dimension: input.dimension,
        tier: input.tier,
        source: input.source,
        status: input.status,
      },
    });

    return rule;
  }

  /**
   * Source = `stated`: the user typed a rule directly, so it is `active` immediately (they said it) and
   * user-owned (no provider, so it survives forget-on-disconnect). A `subjectRole` makes it a
   * `relational` rule (about a role, never an identity); otherwise it's a pure `style` rule. The
   * `identifying` tier + vault is reached only by the Sent-mail observer (`observeFromSentMail`); a
   * user typing in a concrete contact would arrive with the Memory-screen UI.
   */
  async createStatedRule(userId: string, input: CreateStatedRuleInput): Promise<ProcessRule> {
    return this.capture(userId, {
      domain: input.domain,
      dimension: input.dimension,
      rule: input.rule,
      tier: input.subjectRole ? 'relational' : 'style',
      subjectRole: input.subjectRole,
      subjectVaultRef: null,
      status: 'active',
      source: 'stated',
      derivedFromProvider: null,
    });
  }

  /**
   * Source = `feedback`: when the user leaves a free-text comment on a rated insight, deterministically
   * extract any style-rule candidates it implies and land them as `proposed` rules for the user to
   * confirm (§3 — inferred generalizations are proposed, never asserted). The comment is the user's own
   * words, not connected-source data, so these carry no provider (user-owned; survive disconnect). The
   * insight's kind decides the domain; kinds with no style domain (e.g. money) teach nothing. Returns
   * the candidates captured.
   */
  async captureFromFeedbackComment(
    userId: string,
    insightKind: ResourceKind,
    comment: string | null,
  ): Promise<ReadonlyArray<ProcessRule>> {
    const domain = KIND_TO_PROCESS_DOMAIN[insightKind];
    if (!domain) {
      return [];
    }
    const candidates = extractProcessRuleCandidates(domain, comment);
    const captured: ProcessRule[] = [];
    for (const candidate of candidates) {
      captured.push(
        await this.capture(userId, {
          domain,
          dimension: candidate.dimension,
          rule: candidate.rule,
          tier: 'style',
          subjectRole: null,
          subjectVaultRef: null,
          status: 'proposed',
          source: 'feedback',
          derivedFromProvider: null,
        }),
      );
    }
    return captured;
  }

  /**
   * Source = `observed` (the Sutton experiential core): sample the user's OWN Sent mail, reduce it to
   * minimized style features, and land any dominant pattern as a `proposed` rule for the user to
   * confirm. Strictly gated by the user's explicit opt-in (`learnFromSentMail`) — a new data use — and
   * a no-op when off, when no Google account is connected, or when nothing crosses the confidence
   * threshold. Raw Sent-mail content never leaves `googleOAuthService`; only the minimized samples do,
   * and even those are discarded after aggregation. Rules are tagged `derived_from_provider='google'`
   * so they're purged on disconnect (Phase G). The read itself is audited even when nothing is
   * proposed. Returns how many emails were sampled and how many rules were proposed this pass.
   */
  async observeFromSentMail(userId: string): Promise<{ sampled: number; proposed: number }> {
    if (!(await preferencesService.learnFromSentMail(userId))) {
      return { sampled: 0, proposed: 0 };
    }

    const connections = await connectionRepository.listActive(userId, 'google');
    if (connections.length === 0) {
      return { sampled: 0, proposed: 0 };
    }

    const { maxSamples, lookbackDays, minSupport, minShare } = config.sentMailObserver;
    const samples: SentMailSample[] = [];
    // The strongest recurring CC contact across all connected accounts — the identity kept ONLY to
    // role-abstract or vault it, never persisted in the clear and never handed to the model.
    let topRecurringCc: RecurringCcContact | null = null;
    for (const connection of connections) {
      try {
        const refreshToken = await vault.get(connection.vaultRef);
        const observation = await fetchSentMailSamples(
          refreshToken,
          lookbackDays,
          maxSamples,
          connection.accountEmail,
        );
        samples.push(...observation.samples);
        if (
          observation.recurringCc &&
          (!topRecurringCc || observation.recurringCc.count > topRecurringCc.count)
        ) {
          topRecurringCc = observation.recurringCc;
        }
      } catch (error) {
        // One account failing must not sink the pass. A lost grant (revoked/expired token) is handled
        // by the derived-facts path and disconnect flow; here we just skip so the rest still count. A
        // genuinely unexpected failure is reported but still doesn't abort the pass.
        if (!isGoogleAuthError(error)) {
          Sentry.captureException(error);
        }
        continue;
      }
    }

    if (samples.length === 0) {
      return { sampled: 0, proposed: 0 };
    }

    const candidates = observeSentMailStyle(
      samples,
      { minSupport, minShare },
      topRecurringCc ? { count: topRecurringCc.count, sameDomain: topRecurringCc.sameDomain } : null,
    );

    // Audit the pass itself — reading Sent mail is a data use, logged even when nothing is proposed.
    await auditWriter.write({
      userId,
      action: 'read',
      resourceType: 'gmail',
      resourceId: null,
      summary: `Observed writing style from ${samples.length} sent email(s)`,
      success: true,
      metadata: {
        sampled: samples.length,
        proposed: candidates.length,
        source: 'sent_mail_observer',
      },
    });

    for (const candidate of candidates) {
      // An `identifying` recipient rule needs a vaulted handle for the concrete contact; every other
      // rule carries no identity. `resolveVaultRef` reuses an existing handle for the same axis so a
      // repeatedly-running observer never stacks duplicate encrypted copies of the same contact.
      const subjectVaultRef =
        candidate.needsVault && topRecurringCc
          ? await this.resolveVaultRef(
              userId,
              candidate.dimension,
              candidate.subjectRole,
              topRecurringCc.address,
            )
          : null;
      await this.capture(userId, {
        domain: 'email',
        dimension: candidate.dimension,
        rule: candidate.rule,
        tier: candidate.tier,
        subjectRole: candidate.subjectRole,
        subjectVaultRef,
        status: 'proposed',
        source: 'observed',
        derivedFromProvider: 'google',
        confidence: candidate.confidence,
        supportCount: candidate.supportCount,
      });
    }

    return { sampled: samples.length, proposed: candidates.length };
  }

  /**
   * Resolve the vault handle to store for an `identifying` recipient rule. Reuses the handle already on
   * that axis when present (the recurring contact is conceptually the same slot) so the observer never
   * stacks duplicate encrypted copies pass after pass; only a brand-new axis mints a fresh handle. The
   * plaintext address enters the vault and nothing else — it is never written to the row or the model.
   */
  private async resolveVaultRef(
    userId: string,
    dimension: ProcessDimension,
    subjectRole: string | null,
    address: string,
  ): Promise<string> {
    const existingRef = await processMemoryRepository.findVaultRefByAxis(
      userId,
      'email',
      dimension,
      subjectRole,
    );
    return existingRef ?? vault.put(address);
  }

  /**
   * The style profile to apply when shaping a task in a domain: the user's active, visible rules as
   * short plain-language lines the model can drop into its system message ("How this user likes email
   * done: …"). Empty when nothing is active. Bounded by config so it can't balloon the prompt. A
   * `relational` rule names its role (never an identity); `identifying` rules carry no plaintext here,
   * so their line reads generically.
   */
  async recall(userId: string, domain: ProcessDomain): Promise<ReadonlyArray<string>> {
    const rules = await processMemoryRepository.recallForDomain(
      userId,
      domain,
      config.processMemory.recallLimit,
    );
    return rules.map((r) =>
      r.subjectRole ? `${r.rule} (with your ${humanizeRole(r.subjectRole)})` : r.rule,
    );
  }

  /**
   * List the user's own rules for the Memory screen. Optional domain/status/lexical filters. A plain
   * owner read — no broker, no policy — surfaced so the profile stays fully visible (§5).
   */
  async listRules(
    userId: string,
    filters: ListProcessRuleFilters,
  ): Promise<ReadonlyArray<ProcessRule>> {
    return processMemoryRepository.list(userId, filters);
  }

  /**
   * Apply a user's edit to one of their rules (revise the text, confirm/mute via status, or toggle
   * visibility). Scoped to the owner — a foreign or missing id is a 404. The user authoring the change
   * is itself a signal, so it's audited as `learn`.
   */
  async updateRule(
    userId: string,
    id: string,
    patch: UpdateProcessRulePatch,
  ): Promise<ProcessRule> {
    const existing = await processMemoryRepository.findByIdForUser(id, userId);
    if (!existing) {
      throw new NotFoundError('Process rule not found');
    }

    const rule = await processMemoryRepository.update(id, userId, patch);

    await auditWriter.write({
      userId,
      action: 'learn',
      resourceType: 'process_profile',
      resourceId: rule.id,
      summary: `Edited a ${rule.domain} style rule (${rule.dimension})`,
      success: true,
      metadata: {
        domain: rule.domain,
        dimension: rule.dimension,
        status: rule.status,
        visible: rule.visible,
        textChanged: patch.rule !== undefined,
      },
    });

    return rule;
  }

  /**
   * Really delete one rule the user owns (no soft-delete — §5). Scoped to the owner; a foreign or
   * missing id is a 404. Audited as `forget` so deletions are as visible as writes.
   */
  async deleteRule(userId: string, id: string): Promise<void> {
    const existing = await processMemoryRepository.findByIdForUser(id, userId);
    if (!existing) {
      throw new NotFoundError('Process rule not found');
    }

    await processMemoryRepository.delete(id, userId);

    await auditWriter.write({
      userId,
      action: 'forget',
      resourceType: 'process_profile',
      resourceId: id,
      summary: `Forgot a ${existing.domain} style rule (${existing.dimension})`,
      success: true,
      metadata: { domain: existing.domain, dimension: existing.dimension },
    });
  }

  /**
   * The Sutton reinforce/decay step: after the user rates an insight, move the rules that shaped that
   * domain's advice by the rating's reward. The rated insight's kind picks the domain (kinds with no
   * style domain teach nothing); reinforcement lands on exactly the active/visible rules recall would
   * have injected, so credit goes to the rules actually used. A positive rating strengthens them (and
   * counts as another observation); a negative one decays them, eventually dropping a rule out of
   * recall — a visible, honest override. Pure counter movement, so it can never silently clobber a
   * confirmed rule (§3); the feedback event is already audited by `feedbackService`, so no extra audit
   * noise here. Returns how many rules were reinforced.
   */
  async reinforceForFeedback(
    userId: string,
    insightKind: ResourceKind,
    rewardScore: number,
  ): Promise<number> {
    const domain = KIND_TO_PROCESS_DOMAIN[insightKind];
    if (!domain) {
      return 0;
    }
    const { recallLimit, confidenceStep } = config.processMemory;
    const { rewardDelta, confidenceDelta, supportDelta } = reinforcementDeltas(
      rewardScore,
      confidenceStep,
    );
    return processMemoryRepository.reinforceActiveForDomain(
      userId,
      domain,
      recallLimit,
      rewardDelta,
      confidenceDelta,
      supportDelta,
    );
  }

  /**
   * Forget-on-disconnect: purge the rules a user built from a source they just revoked. Scoped like
   * `memoryService.forgetForDisconnectedProvider` — a rule's DOMAIN is forgotten only once NO active
   * connection still authorizes the kind that feeds it (the policy engine is the source of truth), so
   * a user with a second Google account keeps their email/calendar style. Before deleting the rows,
   * their vault handles are read and the referenced encrypted contacts are purged too, so an
   * `identifying` rule never orphans a secret in the vault. User-authored rules carry no provider and
   * are kept. Audited per forgotten domain. Returns how many rules were removed in total.
   */
  async forgetForDisconnectedProvider(userId: string, provider: string): Promise<number> {
    let removed = 0;
    for (const kind of PROCESS_SCOPE_KINDS) {
      if (KIND_TO_PROVIDER[kind] !== provider) {
        continue;
      }
      const domain = KIND_TO_PROCESS_DOMAIN[kind];
      if (!domain) {
        continue;
      }
      const decision = await policyEngine.canRead(userId, kind);
      if (decision.allowed) {
        continue;
      }

      // Read the vault handles first (the rows are about to go), then delete rows, then purge the
      // referenced secrets. Vault deletes are best-effort — an already-purged secret must not block
      // the forget — so a failure is reported but doesn't abort the disconnect.
      const vaultRefs = await processMemoryRepository.vaultRefsByProviderDomain(
        userId,
        provider,
        domain,
      );
      const domainRemoved = await processMemoryRepository.deleteByProviderDomain(
        userId,
        provider,
        domain,
      );
      for (const ref of vaultRefs) {
        try {
          await vault.delete(ref);
        } catch (error) {
          Sentry.captureException(error);
        }
      }

      if (domainRemoved > 0) {
        removed += domainRemoved;
        await auditWriter.write({
          userId,
          action: 'forget',
          resourceType: 'process_profile',
          resourceId: null,
          summary: `Forgot ${domainRemoved} ${domain} style rule(s) from disconnected ${provider}`,
          success: true,
          metadata: { provider, domain, removed: domainRemoved, vaultRefsPurged: vaultRefs.length },
        });
      }
    }
    return removed;
  }
}

export const processMemoryService = new ProcessMemoryService();
