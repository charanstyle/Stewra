import { sql } from 'kysely';
import type {
  CommerceBillingCollector,
  CommercePlan,
  CommercePlanVersion,
  CommerceSubscriptionView,
} from '@stewra/shared-types';
import { db } from '../../database/index.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';

/**
 * The catalog (migration 053). Plans are names; versions are the immutable numbers; a subscription
 * freezes one version for one org. All fee micros are bigint end to end — pg returns int8 as
 * strings, converted with BigInt(), never Number().
 */

interface PlanRow {
  id: string;
  name: string;
  created_at: Date;
}

interface VersionRow {
  id: string;
  plan_id: string;
  version: number;
  platform_fee_micros: string;
  currency: string;
  note: string;
  created_by_user_id: string | null;
  created_at: Date;
}

function toPlan(row: PlanRow): CommercePlan {
  return { id: row.id, name: row.name, createdAt: row.created_at.toISOString() };
}

function toVersion(row: VersionRow): CommercePlanVersion {
  return {
    id: row.id,
    planId: row.plan_id,
    version: row.version,
    platformFeeMicros: row.platform_fee_micros,
    currency: row.currency,
    note: row.note,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at.toISOString(),
  };
}

/** The subscription join every reader wants: the row plus the plan-version facts it froze. */
const subscriptionSelect = [
  'commerce_subscriptions.id as id',
  'commerce_subscriptions.org_id as org_id',
  'commerce_subscriptions.started_at as started_at',
  'commerce_subscriptions.ended_at as ended_at',
  'commerce_subscriptions.collector as collector',
  'commerce_subscriptions.note as note',
  'commerce_subscriptions.created_at as created_at',
  'commerce_plan_versions.id as plan_version_id',
  'commerce_plan_versions.version as plan_version',
  'commerce_plan_versions.platform_fee_micros as platform_fee_micros',
  'commerce_plan_versions.currency as currency',
  'commerce_plans.id as plan_id',
  'commerce_plans.name as plan_name',
] as const;

interface SubscriptionViewRow {
  id: string;
  org_id: string;
  started_at: Date;
  ended_at: Date | null;
  collector: CommerceBillingCollector;
  note: string;
  created_at: Date;
  plan_version_id: string;
  plan_version: number;
  platform_fee_micros: string;
  currency: string;
  plan_id: string;
  plan_name: string;
}

function toSubscriptionView(row: SubscriptionViewRow): CommerceSubscriptionView {
  return {
    id: row.id,
    orgId: row.org_id,
    planId: row.plan_id,
    planName: row.plan_name,
    planVersionId: row.plan_version_id,
    planVersion: row.plan_version,
    platformFeeMicros: row.platform_fee_micros,
    currency: row.currency,
    collector: row.collector,
    note: row.note,
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at === null ? null : row.ended_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

class PlanRepository {
  /**
   * Create the plan if the name is new, and append the next version either way. The version number
   * is computed inside the transaction; the (plan, version) unique constraint catches the race two
   * concurrent upserts would otherwise win together.
   */
  async upsertPlanVersion(params: {
    name: string;
    platformFeeMicros: bigint;
    currency: string;
    note: string;
    createdByUserId: string | null;
  }): Promise<{ plan: CommercePlan; version: CommercePlanVersion }> {
    return db.transaction().execute(async (trx) => {
      await trx
        .insertInto('commerce_plans')
        .values({ name: params.name })
        .onConflict((oc) => oc.column('name').doNothing())
        .execute();
      const plan = await trx
        .selectFrom('commerce_plans')
        .selectAll()
        .where('name', '=', params.name)
        .executeTakeFirstOrThrow();

      const last = await trx
        .selectFrom('commerce_plan_versions')
        .select(({ fn }) => fn.max<number | null>('version').as('max_version'))
        .where('plan_id', '=', plan.id)
        .executeTakeFirst();
      const nextVersion = (last?.max_version ?? 0) + 1;

      const version = await trx
        .insertInto('commerce_plan_versions')
        .values({
          plan_id: plan.id,
          version: nextVersion,
          platform_fee_micros: params.platformFeeMicros.toString(),
          currency: params.currency,
          note: params.note,
          created_by_user_id: params.createdByUserId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      return { plan: toPlan(plan), version: toVersion(version) };
    });
  }

  /** The whole catalog: every plan with every version, newest version first. */
  async listPlans(): Promise<{ plan: CommercePlan; versions: CommercePlanVersion[] }[]> {
    const plans = await db.selectFrom('commerce_plans').selectAll().orderBy('name').execute();
    const versions = await db
      .selectFrom('commerce_plan_versions')
      .selectAll()
      .orderBy('plan_id')
      .orderBy('version', 'desc')
      .execute();
    const byPlan = new Map<string, CommercePlanVersion[]>();
    for (const v of versions) {
      const list = byPlan.get(v.plan_id) ?? [];
      list.push(toVersion(v));
      byPlan.set(v.plan_id, list);
    }
    return plans.map((p) => ({ plan: toPlan(p), versions: byPlan.get(p.id) ?? [] }));
  }

  /**
   * Put an org on a plan's LATEST version, or (planId null) off every plan. One transaction: the
   * active row is ended and the new one inserted, so the partial unique index never sees two open
   * rows even mid-assignment.
   *
   * `collector` has no default anywhere in the stack, deliberately. The wrong value here is not a
   * cosmetic mistake: marking an App Store subscriber as `stewra_stripe` invoices and charges a
   * customer Apple is already billing, and marking a web subscriber as `apple` means nobody ever
   * bills them at all. Whoever assigns the plan says who collects, or the write does not happen.
   */
  async setSubscription(params: {
    orgId: string;
    planId: string | null;
    collector: CommerceBillingCollector | null;
    note: string;
    createdByUserId: string | null;
  }): Promise<CommerceSubscriptionView | null> {
    return db.transaction().execute(async (trx) => {
      await trx
        .updateTable('commerce_subscriptions')
        .set({ ended_at: new Date() })
        .where('org_id', '=', params.orgId)
        .where('ended_at', 'is', null)
        .execute();
      if (params.planId === null) return null;
      // Subscribing without saying who collects is not a shape this will guess its way out of.
      // The controller's schema already refuses it; this is the same refusal at the only place
      // that actually writes, so a future caller reaching the repository directly hits it too.
      if (params.collector === null) {
        throw new ValidationError('Validation failed', [
          { field: 'collector', message: 'collector is required when subscribing to a plan' },
        ]);
      }
      const collector = params.collector;

      const latest = await trx
        .selectFrom('commerce_plan_versions')
        .select('id')
        .where('plan_id', '=', params.planId)
        .orderBy('version', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (latest === undefined) {
        throw new NotFoundError(`Plan ${params.planId} does not exist or has no versions.`);
      }

      const inserted = await trx
        .insertInto('commerce_subscriptions')
        .values({
          org_id: params.orgId,
          plan_version_id: latest.id,
          collector,
          note: params.note,
          created_by_user_id: params.createdByUserId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const row = await trx
        .selectFrom('commerce_subscriptions')
        .innerJoin(
          'commerce_plan_versions',
          'commerce_plan_versions.id',
          'commerce_subscriptions.plan_version_id',
        )
        .innerJoin('commerce_plans', 'commerce_plans.id', 'commerce_plan_versions.plan_id')
        .select(subscriptionSelect)
        .where('commerce_subscriptions.id', '=', inserted.id)
        .executeTakeFirstOrThrow();
      return toSubscriptionView(row);
    });
  }

  /**
   * A plan by its catalog name. Used by the store-purchase path, which is told WHICH plan a
   * verified App Store or Play purchase buys by name (`COMMERCE_STORE_PLAN_NAME`) rather than by
   * id — an id is generated per install and could not be written into a deploy env, and a name is
   * the thing an operator actually typed when they loaded the catalog.
   */
  async findPlanByName(name: string): Promise<CommercePlan | null> {
    const row = await db
      .selectFrom('commerce_plans')
      .selectAll()
      .where('name', '=', name)
      .executeTakeFirst();
    return row === undefined ? null : toPlan(row);
  }

  /** The org's active subscription (ended_at null), if any. */
  async activeSubscription(orgId: string): Promise<CommerceSubscriptionView | null> {
    const row = await db
      .selectFrom('commerce_subscriptions')
      .innerJoin(
        'commerce_plan_versions',
        'commerce_plan_versions.id',
        'commerce_subscriptions.plan_version_id',
      )
      .innerJoin('commerce_plans', 'commerce_plans.id', 'commerce_plan_versions.plan_id')
      .select(subscriptionSelect)
      .where('commerce_subscriptions.org_id', '=', orgId)
      .where('commerce_subscriptions.ended_at', 'is', null)
      .executeTakeFirst();
    return row === undefined ? null : toSubscriptionView(row);
  }

  /**
   * The subscription that overlapped [from, to), for the billing close. The flat fee is not
   * prorated — a subscription active for any part of the month owes the month's fee — so overlap
   * is the whole question. If more than one overlapped (the org changed plans mid-month), the one
   * holding at the period's END wins: the fee follows where the org landed, and exactly one fee is
   * charged either way.
   */
  async subscriptionForPeriod(
    orgId: string,
    from: Date,
    to: Date,
  ): Promise<CommerceSubscriptionView | null> {
    const row = await db
      .selectFrom('commerce_subscriptions')
      .innerJoin(
        'commerce_plan_versions',
        'commerce_plan_versions.id',
        'commerce_subscriptions.plan_version_id',
      )
      .innerJoin('commerce_plans', 'commerce_plans.id', 'commerce_plan_versions.plan_id')
      .select(subscriptionSelect)
      .where('commerce_subscriptions.org_id', '=', orgId)
      .where('commerce_subscriptions.started_at', '<', to)
      .where((eb) =>
        eb.or([
          eb('commerce_subscriptions.ended_at', 'is', null),
          eb('commerce_subscriptions.ended_at', '>', from),
        ]),
      )
      .orderBy(sql`coalesce(commerce_subscriptions.ended_at, 'infinity'::timestamptz)`, 'desc')
      .orderBy('commerce_subscriptions.started_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row === undefined ? null : toSubscriptionView(row);
  }
}

export const planRepository = new PlanRepository();
