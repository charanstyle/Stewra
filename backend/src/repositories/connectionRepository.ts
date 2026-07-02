import type {
  Connection,
  ConnectionProvider,
  ConnectionStatus,
} from '@stewra/shared-types';
import { db } from '../database/index';

/** A connection row as the control plane needs it internally (includes the vault handle). */
export interface ConnectionRow {
  readonly id: string;
  readonly userId: string;
  readonly provider: string;
  readonly accountEmail: string;
  readonly vaultRef: string;
  readonly status: string;
}

/** Narrow a stored provider string to the union, failing loud on an unknown value. */
function toConnectionProvider(value: string): ConnectionProvider {
  if (value === 'google' || value === 'aggregator') {
    return value;
  }
  throw new Error(`unknown connection provider: ${value}`);
}

/** Narrow a stored status string to the union, failing loud on an unknown value. */
function toConnectionStatus(value: string): ConnectionStatus {
  if (value === 'active' || value === 'revoked') {
    return value;
  }
  throw new Error(`unknown connection status: ${value}`);
}

/**
 * Data access for connections. The `vault_ref` stays inside the control plane and is never mapped
 * into the public `Connection` shape — the client and the agent never see it.
 */
export class ConnectionRepository {
  /** Every active connection for a (user, provider) — one per connected account. */
  async listActive(
    userId: string,
    provider: ConnectionProvider,
  ): Promise<ReadonlyArray<ConnectionRow>> {
    const rows = await db
      .selectFrom('connections')
      .selectAll()
      .where('user_id', '=', userId)
      .where('provider', '=', provider)
      .where('status', '=', 'active')
      .orderBy('created_at', 'asc')
      .execute();
    return rows.map((r) => this.toRow(r));
  }

  /**
   * Create or re-activate one (user, provider, account) connection, pointing it at a fresh vault
   * handle. Reconnecting the same account upserts in place; a new account inserts a new row.
   */
  async upsert(
    userId: string,
    provider: ConnectionProvider,
    accountEmail: string,
    vaultRef: string,
  ): Promise<ConnectionRow> {
    const row = await db
      .insertInto('connections')
      .values({
        user_id: userId,
        provider,
        account_email: accountEmail,
        vault_ref: vaultRef,
        status: 'active',
      })
      .onConflict((oc) =>
        oc
          .columns(['user_id', 'provider', 'account_email'])
          .doUpdateSet({ vault_ref: vaultRef, status: 'active' }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return this.toRow(row);
  }

  /**
   * The vault handle currently held for one (user, provider, account), if any. Read just before an
   * upsert so the caller can delete the superseded secret when reconnecting the same account —
   * otherwise the old encrypted token would be orphaned in the vault forever.
   */
  async vaultRefForAccount(
    userId: string,
    provider: ConnectionProvider,
    accountEmail: string,
  ): Promise<string | undefined> {
    const row = await db
      .selectFrom('connections')
      .select('vault_ref')
      .where('user_id', '=', userId)
      .where('provider', '=', provider)
      .where('account_email', '=', accountEmail)
      .executeTakeFirst();
    return row?.vault_ref;
  }

  /** Public-facing list for the trust/control surfaces (no vault handle). */
  async listForUser(userId: string): Promise<ReadonlyArray<Connection>> {
    const rows = await db
      .selectFrom('connections')
      .selectAll()
      .where('user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map((r) => this.toPublic(r));
  }

  async findByIdForUser(id: string, userId: string): Promise<ConnectionRow | undefined> {
    const row = await db
      .selectFrom('connections')
      .selectAll()
      .where('id', '=', id)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row ? this.toRow(row) : undefined;
  }

  async setStatus(id: string, status: ConnectionStatus): Promise<Connection> {
    const row = await db
      .updateTable('connections')
      .set({ status })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return this.toPublic(row);
  }

  private toRow(row: {
    id: string;
    user_id: string;
    provider: string;
    account_email: string;
    vault_ref: string;
    status: string;
  }): ConnectionRow {
    return {
      id: row.id,
      userId: row.user_id,
      provider: row.provider,
      accountEmail: row.account_email,
      vaultRef: row.vault_ref,
      status: row.status,
    };
  }

  private toPublic(row: {
    id: string;
    provider: string;
    account_email: string;
    status: string;
    created_at: Date;
  }): Connection {
    return {
      id: row.id,
      provider: toConnectionProvider(row.provider),
      accountEmail: row.account_email,
      status: toConnectionStatus(row.status),
      createdAt: row.created_at.toISOString(),
    };
  }
}

export const connectionRepository = new ConnectionRepository();
