import { sql } from 'kysely';
import type { CommerceSpendCap, CommerceSpendUsage } from '@stewra/shared-types';
import { db } from '../../database/index.js';
import { isUniqueViolation } from '../../database/pgErrors.js';

/**
 * The cap tables (migration 052). The one rule everything here serves: **headroom is consumed by a
 * single UPDATE whose WHERE clause holds the limit.** Two workers racing the last of an org's
 * allowance both reach the same row, one blocks on the row lock, re-evaluates the predicate against
 * the winner's counters, and fails — no code path exists that both can pass.
 *
 * All micros are bigint end to end: pg returns int8 as strings, converted with BigInt(), never
 * Number().
 */

/** First day of `at`'s calendar month, UTC, as the YYYY-MM-DD string pg's `date` type wants. */
export function periodStartFor(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

interface CapRow {
  id: string;
  org_id: string;
  currency: string;
  limit_micros: string;
  granted_by_user_id: string | null;
  note: string;
  created_at: Date;
  updated_at: Date;
}

function toCap(row: CapRow): CommerceSpendCap {
  return {
    id: row.id,
    orgId: row.org_id,
    currency: row.currency,
    limitMicros: row.limit_micros,
    grantedByUserId: row.granted_by_user_id,
    note: row.note,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

class SpendCapRepository {
  /**
   * Grant or replace the (org, currency) cap, and record the grant in the ledger — one
   * transaction, so a limit and its evidence cannot exist without each other.
   */
  async setCap(params: {
    orgId: string;
    currency: string;
    limitMicros: bigint;
    grantedByUserId: string | null;
    note: string;
  }): Promise<CommerceSpendCap> {
    return db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto('commerce_spend_caps')
        .values({
          org_id: params.orgId,
          currency: params.currency,
          limit_micros: params.limitMicros.toString(),
          granted_by_user_id: params.grantedByUserId,
          note: params.note,
        })
        .onConflict((oc) =>
          oc.columns(['org_id', 'currency']).doUpdateSet({
            limit_micros: params.limitMicros.toString(),
            granted_by_user_id: params.grantedByUserId,
            note: params.note,
            updated_at: new Date(),
          }),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('commerce_spend_ledger')
        .values({
          org_id: params.orgId,
          currency: params.currency,
          period_start: periodStartFor(new Date()),
          kind: 'cap_set',
          amount_micros: params.limitMicros.toString(),
          note: params.note,
        })
        .execute();
      return toCap(row);
    });
  }

  async listCaps(orgId: string): Promise<CommerceSpendCap[]> {
    const rows = await db
      .selectFrom('commerce_spend_caps')
      .selectAll()
      .where('org_id', '=', orgId)
      .orderBy('currency')
      .execute();
    return rows.map(toCap);
  }

  /**
   * What this month still allows, per currency the org has ever been capped or charged in. The
   * absent-cap default surfaces here as `limitMicros: null, headroomMicros: "0"` — zero, not
   * unlimited.
   */
  async usage(orgId: string, at: Date): Promise<CommerceSpendUsage[]> {
    const periodStart = periodStartFor(at);
    const caps = await db
      .selectFrom('commerce_spend_caps')
      .select(['currency', 'limit_micros'])
      .where('org_id', '=', orgId)
      .execute();
    const periods = await db
      .selectFrom('commerce_spend_periods')
      .select(['currency', 'reserved_micros', 'actual_micros'])
      .where('org_id', '=', orgId)
      .where('period_start', '=', sql<Date>`${periodStart}::date`)
      .execute();

    const currencies = new Set<string>();
    const limitBy = new Map<string, string>();
    for (const cap of caps) {
      currencies.add(cap.currency);
      limitBy.set(cap.currency, cap.limit_micros);
    }
    const periodBy = new Map<string, { reserved: string; actual: string }>();
    for (const p of periods) {
      currencies.add(p.currency);
      periodBy.set(p.currency, { reserved: p.reserved_micros, actual: p.actual_micros });
    }

    return [...currencies].sort().map((currency) => {
      const limit = limitBy.get(currency) ?? null;
      const period = periodBy.get(currency) ?? { reserved: '0', actual: '0' };
      const headroom =
        limit === null
          ? 0n
          : BigInt(limit) - BigInt(period.reserved) - BigInt(period.actual);
      return {
        currency,
        periodStart,
        reservedMicros: period.reserved,
        actualMicros: period.actual,
        limitMicros: limit,
        headroomMicros: (headroom > 0n ? headroom : 0n).toString(),
      };
    });
  }

  /** Convenience over {@link usage}: this month's remaining allowance for one currency. */
  async headroom(orgId: string, currency: string, at: Date): Promise<bigint> {
    const all = await this.usage(orgId, at);
    const entry = all.find((u) => u.currency === currency);
    return entry === undefined ? 0n : BigInt(entry.headroomMicros);
  }

  /**
   * Check-and-consume. Returns 'reserved' with the money held against this month, or
   * 'insufficient' — which is also what an org with no cap row gets, because the UPDATE's join to
   * `commerce_spend_caps` finds nothing to satisfy. `messageId` must already exist; the ledger's
   * partial unique index makes a second reservation for the same message impossible.
   */
  async reserve(params: {
    orgId: string;
    currency: string;
    amountMicros: bigint;
    messageId: string;
    broadcastId: string | null;
    at: Date;
  }): Promise<'reserved' | 'insufficient'> {
    const periodStart = periodStartFor(params.at);
    const amount = params.amountMicros.toString();
    return db.transaction().execute(async (trx) => {
      await trx
        .insertInto('commerce_spend_periods')
        .values({
          org_id: params.orgId,
          currency: params.currency,
          period_start: periodStart,
        })
        .onConflict((oc) => oc.columns(['org_id', 'currency', 'period_start']).doNothing())
        .execute();

      const consumed = await sql<{ id: string }>`
        UPDATE commerce_spend_periods p
        SET reserved_micros = p.reserved_micros + ${amount}::bigint
        FROM commerce_spend_caps c
        WHERE p.org_id = ${params.orgId}
          AND p.currency = ${params.currency}
          AND p.period_start = ${periodStart}::date
          AND c.org_id = p.org_id
          AND c.currency = p.currency
          AND p.reserved_micros + p.actual_micros + ${amount}::bigint <= c.limit_micros
        RETURNING p.id
      `.execute(trx);
      if (consumed.rows.length === 0) return 'insufficient';

      await trx
        .insertInto('commerce_spend_ledger')
        .values({
          org_id: params.orgId,
          currency: params.currency,
          period_start: periodStart,
          kind: 'reserve',
          amount_micros: amount,
          message_id: params.messageId,
          broadcast_id: params.broadcastId,
        })
        .execute();
      return 'reserved';
    });
  }

  /**
   * Close a message's reservation: 'release' gives the whole held amount back (Meta refused the
   * send — the spend certainly did not happen); 'settle' moves it to actuals at what the receipt
   * really priced, which may be more, less, or zero.
   *
   * The closing ledger entry is inserted FIRST, inside the transaction, so the partial unique
   * index aborts a duplicate close before any counter moves — a replayed webhook cannot credit a
   * period twice. Returns 'closed', 'already_settled'/'already_released' (which prior close won),
   * or 'no_reservation' (a message that was never reserved — an inbound-conversation charge, or a
   * send from before the cap existed).
   */
  async closeReservation(params: {
    messageId: string;
    outcome: 'release' | 'settle';
    /** The receipt's real charge; required for settle, ignored for release. */
    actualMicros?: bigint;
    /**
     * The currency the receipt priced in. If it differs from the reservation's (the WABA's billing
     * currency changed between send and receipt), the hold is freed in its own currency and the
     * actual is recorded at zero here — the caller must book the real charge separately via
     * {@link recordUnreservedActual} in the receipt's currency. Micros of two currencies must never
     * be added into one counter.
     */
    actualCurrency?: string;
    note?: string;
  }): Promise<
    | 'closed'
    | 'closed_currency_mismatch'
    | 'already_settled'
    | 'already_released'
    | 'no_reservation'
  > {
    const reservation = await db
      .selectFrom('commerce_spend_ledger')
      .select(['org_id', 'currency', 'period_start', 'amount_micros', 'broadcast_id'])
      .where('message_id', '=', params.messageId)
      .where('kind', '=', 'reserve')
      .executeTakeFirst();
    if (reservation === undefined) return 'no_reservation';

    const mismatch =
      params.outcome === 'settle' &&
      params.actualCurrency !== undefined &&
      params.actualCurrency !== reservation.currency;
    // A mismatched settle closes as a RELEASE: the hold is freed in its own currency, and the
    // closing slot must stay a release so the caller's recordUnreservedActual — the real charge, in
    // the receipt's currency — is not blocked by the one-close-per-message index.
    const closingKind = mismatch ? 'release' : params.outcome;
    const reserved = BigInt(reservation.amount_micros);
    const actual = closingKind === 'settle' ? (params.actualMicros ?? 0n) : 0n;
    const periodStart = periodStartFor(reservation.period_start);
    try {
      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto('commerce_spend_ledger')
          .values({
            org_id: reservation.org_id,
            currency: reservation.currency,
            period_start: periodStart,
            kind: params.outcome,
            amount_micros: actual.toString(),
            message_id: params.messageId,
            broadcast_id: reservation.broadcast_id,
            note: params.note ?? null,
          })
          .execute();
        // Credit the reservation's own period — a receipt landing in June still frees May's hold.
        await sql`
          UPDATE commerce_spend_periods
          SET reserved_micros = reserved_micros - ${reserved.toString()}::bigint,
              actual_micros = actual_micros + ${actual.toString()}::bigint
          WHERE org_id = ${reservation.org_id}
            AND currency = ${reservation.currency}
            AND period_start = ${periodStart}::date
        `.execute(trx);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Which close got there first changes what the caller must do next: a prior SETTLE means
        // the charge is on the books; a prior RELEASE (a refused send — or the backfill freeing a
        // reservation whose receipt timed out) means a real charge arriving NOW still needs to be
        // booked, unreserved. The distinction is one read of the row that beat us.
        const existing = await db
          .selectFrom('commerce_spend_ledger')
          .select('kind')
          .where('message_id', '=', params.messageId)
          .where('kind', 'in', ['release', 'settle'])
          .executeTakeFirst();
        return existing?.kind === 'settle' ? 'already_settled' : 'already_released';
      }
      throw error;
    }
    return mismatch ? 'closed_currency_mismatch' : 'closed';
  }

  /**
   * Reservations the backfill should give up on: held for a message whose receipt never came
   * (`billable` still NULL) and whose send is older than `before`. Anchored on the MESSAGE's
   * `created_at` — the age of the send is the fact that matters, and the ledger's own timestamps
   * are behind an append-only trigger. Reservations for messages whose receipt DID arrive but
   * could not be priced (`unrated_*`) are deliberately absent here: money that cannot be priced
   * must not free headroom.
   */
  async staleOpenReservations(params: {
    orgId: string;
    before: Date;
    limit: number;
  }): Promise<{ messageId: string }[]> {
    const rows = await sql<{ message_id: string }>`
      SELECT l.message_id
      FROM commerce_spend_ledger l
      JOIN commerce_messages m ON m.id = l.message_id
      WHERE l.org_id = ${params.orgId}
        AND l.kind = 'reserve'
        AND m.billable IS NULL
        AND ${params.before} > m.created_at
        AND NOT EXISTS (
          SELECT 1 FROM commerce_spend_ledger c
          WHERE c.message_id = l.message_id AND c.kind IN ('release', 'settle')
        )
      LIMIT ${params.limit}
    `.execute(db);
    return rows.rows.map((row) => ({ messageId: row.message_id }));
  }

  /** Which orgs hold stale open reservations — the backfill sweep's second candidate list. */
  async orgsWithStaleOpenReservations(before: Date): Promise<string[]> {
    const rows = await sql<{ org_id: string }>`
      SELECT DISTINCT l.org_id
      FROM commerce_spend_ledger l
      JOIN commerce_messages m ON m.id = l.message_id
      WHERE l.kind = 'reserve'
        AND m.billable IS NULL
        AND ${before} > m.created_at
        AND NOT EXISTS (
          SELECT 1 FROM commerce_spend_ledger c
          WHERE c.message_id = l.message_id AND c.kind IN ('release', 'settle')
        )
    `.execute(db);
    return rows.rows.map((row) => row.org_id);
  }

  /**
   * Record money Meta charged that was never reserved — a conversation opened by the customer, or
   * a send predating the cap. Lands on the month it was priced in; may push actuals past the
   * limit, which is honest: the exposure happened, and hiding it would not unhappen it.
   */
  async recordUnreservedActual(params: {
    orgId: string;
    currency: string;
    amountMicros: bigint;
    messageId: string;
    at: Date;
  }): Promise<'recorded' | 'already_recorded'> {
    const periodStart = periodStartFor(params.at);
    const amount = params.amountMicros.toString();
    try {
      await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('commerce_spend_periods')
        .values({
          org_id: params.orgId,
          currency: params.currency,
          period_start: periodStart,
        })
        .onConflict((oc) => oc.columns(['org_id', 'currency', 'period_start']).doNothing())
        .execute();
      await trx
        .insertInto('commerce_spend_ledger')
        .values({
          org_id: params.orgId,
          currency: params.currency,
          period_start: periodStart,
          kind: 'actual_unreserved',
          amount_micros: amount,
          message_id: params.messageId,
        })
        .execute();
      await sql`
        UPDATE commerce_spend_periods
        SET actual_micros = actual_micros + ${amount}::bigint
        WHERE org_id = ${params.orgId}
          AND currency = ${params.currency}
          AND period_start = ${periodStart}::date
      `.execute(trx);
      });
    } catch (error) {
      // The ledger's one-close-per-message index firing means this exact charge is already on the
      // books — a replayed webhook, not a new fact. Nothing to add and nothing lost.
      if (isUniqueViolation(error)) return 'already_recorded';
      throw error;
    }
    return 'recorded';
  }
}

export const spendCapRepository = new SpendCapRepository();
