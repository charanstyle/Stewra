import { db } from '../database/index.js';

/**
 * Data access for the money store (migration 056). Raw bank records live only here in the control
 * plane; the agent sees derived fact strings. Merchant text arrives already encrypted (the sync
 * service owns fieldCrypto) — this layer never sees plaintext merchants.
 *
 * pg int8 arrives as a string; every amount is converted with BigInt() at this boundary and typed
 * bigint upward — never Number().
 */

export interface MoneyAccountRow {
  readonly id: string;
  readonly connectionId: string;
  readonly plaidAccountId: string;
  readonly name: string;
  readonly accountType: string;
  readonly accountSubtype: string;
  readonly mask: string;
  readonly isoCurrencyCode: string | null;
  readonly availableMicros: bigint | null;
  readonly currentMicros: bigint | null;
  readonly balanceAsOf: Date | null;
}

export interface MoneyTransactionRow {
  readonly id: string;
  readonly accountId: string;
  readonly plaidTransactionId: string;
  readonly merchantCiphertext: string;
  readonly category: string;
  readonly amountMicros: bigint;
  readonly isoCurrencyCode: string | null;
  /** YYYY-MM-DD, as Plaid dates it. */
  readonly postedAt: string;
  readonly pending: boolean;
}

export interface UpsertMoneyAccountParams {
  readonly userId: string;
  readonly connectionId: string;
  readonly plaidAccountId: string;
  readonly name: string;
  readonly accountType: string;
  readonly accountSubtype: string;
  readonly mask: string;
  readonly isoCurrencyCode: string | null;
  readonly availableMicros: bigint | null;
  readonly currentMicros: bigint | null;
  readonly balanceAsOf: Date;
}

export class MoneyAccountRepository {
  /** Create or refresh one account snapshot; balances are overwritten each sync. */
  async upsert(params: UpsertMoneyAccountParams): Promise<MoneyAccountRow> {
    const row = await db
      .insertInto('money_accounts')
      .values({
        user_id: params.userId,
        connection_id: params.connectionId,
        plaid_account_id: params.plaidAccountId,
        name: params.name,
        account_type: params.accountType,
        account_subtype: params.accountSubtype,
        mask: params.mask,
        iso_currency_code: params.isoCurrencyCode,
        available_micros: params.availableMicros,
        current_micros: params.currentMicros,
        balance_as_of: params.balanceAsOf,
      })
      .onConflict((oc) =>
        oc.columns(['connection_id', 'plaid_account_id']).doUpdateSet({
          name: params.name,
          account_type: params.accountType,
          account_subtype: params.accountSubtype,
          mask: params.mask,
          iso_currency_code: params.isoCurrencyCode,
          available_micros: params.availableMicros,
          current_micros: params.currentMicros,
          balance_as_of: params.balanceAsOf,
          updated_at: new Date(),
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return this.toRow(row);
  }

  async listForConnection(connectionId: string): Promise<ReadonlyArray<MoneyAccountRow>> {
    const rows = await db
      .selectFrom('money_accounts')
      .selectAll()
      .where('connection_id', '=', connectionId)
      .orderBy('created_at', 'asc')
      .execute();
    return rows.map((r) => this.toRow(r));
  }

  /** The store id for one Plaid account id — sync uses it to attach transactions. */
  async idForPlaidAccount(connectionId: string, plaidAccountId: string): Promise<string | undefined> {
    const row = await db
      .selectFrom('money_accounts')
      .select('id')
      .where('connection_id', '=', connectionId)
      .where('plaid_account_id', '=', plaidAccountId)
      .executeTakeFirst();
    return row?.id;
  }

  private toRow(row: {
    id: string;
    connection_id: string;
    plaid_account_id: string;
    name: string;
    account_type: string;
    account_subtype: string;
    mask: string;
    iso_currency_code: string | null;
    available_micros: string | null;
    current_micros: string | null;
    balance_as_of: Date | null;
  }): MoneyAccountRow {
    return {
      id: row.id,
      connectionId: row.connection_id,
      plaidAccountId: row.plaid_account_id,
      name: row.name,
      accountType: row.account_type,
      accountSubtype: row.account_subtype,
      mask: row.mask,
      isoCurrencyCode: row.iso_currency_code,
      availableMicros: row.available_micros === null ? null : BigInt(row.available_micros),
      currentMicros: row.current_micros === null ? null : BigInt(row.current_micros),
      balanceAsOf: row.balance_as_of,
    };
  }
}

export interface UpsertMoneyTransactionParams {
  readonly userId: string;
  readonly connectionId: string;
  readonly accountId: string;
  readonly plaidTransactionId: string;
  readonly merchantCiphertext: string;
  readonly category: string;
  readonly amountMicros: bigint;
  readonly isoCurrencyCode: string | null;
  readonly postedAt: string;
  readonly pending: boolean;
}

export class MoneyTransactionRepository {
  /** Insert or replace one transaction (sync's `modified` list reuses the same path). */
  async upsert(params: UpsertMoneyTransactionParams): Promise<void> {
    await db
      .insertInto('money_transactions')
      .values({
        user_id: params.userId,
        connection_id: params.connectionId,
        account_id: params.accountId,
        plaid_transaction_id: params.plaidTransactionId,
        merchant_ciphertext: params.merchantCiphertext,
        category: params.category,
        amount_micros: params.amountMicros,
        iso_currency_code: params.isoCurrencyCode,
        posted_at: params.postedAt,
        pending: params.pending,
      })
      .onConflict((oc) =>
        oc.columns(['connection_id', 'plaid_transaction_id']).doUpdateSet({
          account_id: params.accountId,
          merchant_ciphertext: params.merchantCiphertext,
          category: params.category,
          amount_micros: params.amountMicros,
          iso_currency_code: params.isoCurrencyCode,
          posted_at: params.postedAt,
          pending: params.pending,
        }),
      )
      .execute();
  }

  /** Drop transactions Plaid retracted (a pending charge that posted under a new id, a reversal). */
  async deleteByPlaidIds(connectionId: string, plaidIds: ReadonlyArray<string>): Promise<void> {
    if (plaidIds.length === 0) {
      return;
    }
    await db
      .deleteFrom('money_transactions')
      .where('connection_id', '=', connectionId)
      .where('plaid_transaction_id', 'in', [...plaidIds])
      .execute();
  }

  /** Transactions for one connection posted on/after a date — the fact extractor's read window. */
  async listSince(
    connectionId: string,
    sinceDate: string,
  ): Promise<ReadonlyArray<MoneyTransactionRow>> {
    const rows = await db
      .selectFrom('money_transactions')
      .selectAll()
      .where('connection_id', '=', connectionId)
      .where('posted_at', '>=', new Date(`${sinceDate}T00:00:00`))
      .orderBy('posted_at', 'asc')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      accountId: r.account_id,
      plaidTransactionId: r.plaid_transaction_id,
      merchantCiphertext: r.merchant_ciphertext,
      category: r.category,
      amountMicros: BigInt(r.amount_micros),
      isoCurrencyCode: r.iso_currency_code,
      postedAt: toDateOnly(r.posted_at),
      pending: r.pending,
    }));
  }
}

/** pg `date` arrives as a Date at local midnight; render it back to the YYYY-MM-DD it stores. */
function toDateOnly(value: Date): string {
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, '0');
  const d = String(value.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export interface MoneySyncStateRow {
  readonly connectionId: string;
  readonly cursor: string | null;
  readonly initialSyncComplete: boolean;
  readonly lastSyncedAt: Date | null;
}

export class MoneySyncStateRepository {
  /** Create the row if missing — sync's first step for a connection. */
  async ensure(connectionId: string, userId: string): Promise<void> {
    await db
      .insertInto('money_sync_state')
      .values({ connection_id: connectionId, user_id: userId })
      .onConflict((oc) => oc.column('connection_id').doNothing())
      .execute();
  }

  async getForConnection(connectionId: string): Promise<MoneySyncStateRow | undefined> {
    const row = await db
      .selectFrom('money_sync_state')
      .selectAll()
      .where('connection_id', '=', connectionId)
      .executeTakeFirst();
    if (row === undefined) {
      return undefined;
    }
    return {
      connectionId: row.connection_id,
      cursor: row.cursor,
      initialSyncComplete: row.initial_sync_complete,
      lastSyncedAt: row.last_synced_at,
    };
  }

  async update(
    connectionId: string,
    patch: {
      readonly cursor?: string | null;
      readonly initialSyncComplete?: boolean;
      readonly lastSyncedAt?: Date;
    },
  ): Promise<void> {
    await db
      .updateTable('money_sync_state')
      .set({
        ...(patch.cursor !== undefined ? { cursor: patch.cursor } : {}),
        ...(patch.initialSyncComplete !== undefined
          ? { initial_sync_complete: patch.initialSyncComplete }
          : {}),
        ...(patch.lastSyncedAt !== undefined ? { last_synced_at: patch.lastSyncedAt } : {}),
        updated_at: new Date(),
      })
      .where('connection_id', '=', connectionId)
      .execute();
  }
}

/**
 * Purge everything the money store holds for one connection. Called on disconnect because a revoked
 * connection only flips status — the ON DELETE CASCADE never fires (same reasoning as
 * `purgeConnectionEmailData`). Nothing here is vaulted, so there are no refs to hand back.
 */
export async function purgeConnectionMoneyData(connectionId: string): Promise<void> {
  await db.deleteFrom('money_transactions').where('connection_id', '=', connectionId).execute();
  await db.deleteFrom('money_accounts').where('connection_id', '=', connectionId).execute();
  await db.deleteFrom('money_sync_state').where('connection_id', '=', connectionId).execute();
}

export const moneyAccountRepository = new MoneyAccountRepository();
export const moneyTransactionRepository = new MoneyTransactionRepository();
export const moneySyncStateRepository = new MoneySyncStateRepository();
