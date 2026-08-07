import type { Selectable } from 'kysely';
import type { ChannelAccount, ChannelAccountStatus, CommercePlatform } from '@stewra/shared-types';
import { db } from '../../database/index.js';
import type { ChannelAccountMeta, ChannelAccountsTable } from '../../database/types.js';
import { ConflictError } from '../../utils/errors.js';

/**
 * A row as it exists internally, INCLUDING the vault handle. Never returned to a client — the API
 * shape is {@link ChannelAccount}, which has no `credentialRef` field at all, so there is no
 * serialization path that could leak it by accident.
 */
export interface ChannelAccountRow {
  readonly id: string;
  readonly orgId: string;
  readonly platform: CommercePlatform;
  readonly externalAccountId: string;
  readonly phoneNumberId: string | null;
  readonly displayName: string;
  readonly credentialRef: string;
  readonly status: ChannelAccountStatus;
  readonly errorDetail: string | null;
  readonly meta: ChannelAccountMeta;
  /** When the vaulted credential dies. Null when Meta reported no expiry — see migration 041. */
  readonly credentialExpiresAt: string | null;
  readonly connectedAt: string;
}

function toRow(row: Selectable<ChannelAccountsTable>): ChannelAccountRow {
  return {
    id: row.id,
    orgId: row.org_id,
    platform: row.platform,
    externalAccountId: row.external_account_id,
    phoneNumberId: row.phone_number_id,
    displayName: row.display_name,
    credentialRef: row.credential_ref,
    status: row.status,
    errorDetail: row.error_detail,
    meta: row.meta,
    credentialExpiresAt: row.credential_expires_at?.toISOString() ?? null,
    connectedAt: row.connected_at.toISOString(),
  };
}

/** Drop the vault handle. The one function that turns an internal row into something a client sees. */
export function toChannelAccount(row: ChannelAccountRow): ChannelAccount {
  return {
    id: row.id,
    orgId: row.orgId,
    platform: row.platform,
    externalAccountId: row.externalAccountId,
    phoneNumberId: row.phoneNumberId,
    displayName: row.displayName,
    status: row.status,
    errorDetail: row.errorDetail,
    credentialExpiresAt: row.credentialExpiresAt,
    connectedAt: row.connectedAt,
  };
}

/**
 * The connected messaging accounts of each organization.
 *
 * Two access patterns, and the difference between them matters:
 *
 *  - {@link listForOrg} / {@link findForOrg} are TENANT-SCOPED. They take an `orgId` that
 *    `requireOrgMember` has already verified, and they filter on it.
 *  - {@link findByExternalAccount} is NOT scoped, and cannot be: it is how an inbound webhook
 *    DISCOVERS which tenant a message belongs to. Meta delivers every organization's traffic to one
 *    URL, and the WABA id in the payload is the only thing that says whose it is. It is safe only
 *    because `(platform, external_account_id)` is unique — one WABA belongs to exactly one org — so
 *    it can never return an ambiguous answer. Nothing behind an authenticated route may call it.
 */
class ChannelAccountRepository {
  async listForOrg(orgId: string): Promise<ChannelAccountRow[]> {
    const rows = await db
      .selectFrom('channel_accounts')
      .selectAll()
      .where('org_id', '=', orgId)
      .orderBy('connected_at', 'desc')
      .execute();
    return rows.map(toRow);
  }

  async findForOrg(orgId: string, id: string): Promise<ChannelAccountRow | null> {
    const row = await db
      .selectFrom('channel_accounts')
      .selectAll()
      .where('org_id', '=', orgId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? null : toRow(row);
  }

  /**
   * Resolve an inbound webhook's WABA id to the account — and therefore the organization — that owns
   * it. Returns null for an id nobody has connected; the caller must DROP that delivery rather than
   * guess a tenant, because guessing means showing one business another's customers.
   */
  async findByExternalAccount(
    platform: CommercePlatform,
    externalAccountId: string,
  ): Promise<ChannelAccountRow | null> {
    const row = await db
      .selectFrom('channel_accounts')
      .selectAll()
      .where('platform', '=', platform)
      .where('external_account_id', '=', externalAccountId)
      .executeTakeFirst();
    return row === undefined ? null : toRow(row);
  }

  /**
   * Record a freshly connected account, or refresh an existing connection of the same WABA.
   *
   * Reconnecting is the common case — a client re-runs Embedded Signup after a token is revoked —
   * and it must update the row rather than fail, so the conversation history stays attached.
   *
   * A WABA already claimed by a DIFFERENT organization is refused LOUDLY, by name. Silently moving
   * it would hand one business another's inbox, and the old credential ref would be orphaned in the
   * vault; this situation is rare, real (a shared agency account, a mis-click) and needs a human.
   * The prior `credentialRef` is returned so the caller can delete the superseded secret — dead
   * credentials are not kept at rest.
   */
  async upsert(params: {
    orgId: string;
    platform: CommercePlatform;
    externalAccountId: string;
    phoneNumberId: string | null;
    displayName: string;
    credentialRef: string;
    /** What Meta said about the new credential's lifetime. Null means it reported no expiry. */
    credentialExpiresAt: Date | null;
    meta: ChannelAccountMeta;
  }): Promise<{ account: ChannelAccountRow; supersededCredentialRef: string | null }> {
    return db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom('channel_accounts')
        .selectAll()
        .where('platform', '=', params.platform)
        .where('external_account_id', '=', params.externalAccountId)
        .forUpdate()
        .executeTakeFirst();

      if (existing !== undefined && existing.org_id !== params.orgId) {
        throw new ConflictError(
          `That ${params.platform} account is already connected to another organization. ` +
            'Disconnect it there first, or contact support.',
        );
      }

      const values = {
        phone_number_id: params.phoneNumberId,
        display_name: params.displayName,
        credential_ref: params.credentialRef,
        credential_expires_at: params.credentialExpiresAt,
        meta: JSON.stringify(params.meta),
      };

      if (existing !== undefined) {
        const updated = await trx
          .updateTable('channel_accounts')
          .set({ ...values, status: 'active', error_detail: null })
          .where('id', '=', existing.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        return {
          account: toRow(updated),
          supersededCredentialRef:
            existing.credential_ref === params.credentialRef ? null : existing.credential_ref,
        };
      }

      const inserted = await trx
        .insertInto('channel_accounts')
        .values({
          org_id: params.orgId,
          platform: params.platform,
          external_account_id: params.externalAccountId,
          ...values,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return { account: toRow(inserted), supersededCredentialRef: null };
    });
  }

  /**
   * Mark an account broken, with the reason in words.
   *
   * The reason is required, not optional: an account that stops sending without saying why is the
   * exact failure this column exists to prevent, and a client cannot be asked to reconnect something
   * nobody can explain.
   */
  async markError(id: string, errorDetail: string): Promise<void> {
    await db
      .updateTable('channel_accounts')
      .set({ status: 'error', error_detail: errorDetail })
      .where('id', '=', id)
      .execute();
  }

  /**
   * Accounts whose stored credential dies before `cutoff` — the sweep's only query.
   *
   * NOT tenant-scoped, and cannot be: an expiring token belongs to nobody's request. It is safe for
   * the same reason {@link findByExternalAccount} is — it runs from a background timer, never from
   * an authenticated route, and returns rows only to code that acts on Meta rather than on a client.
   *
   * `credential_expires_at IS NULL` rows are excluded by the comparison itself: a credential Meta
   * says never expires is not a credential about to expire. Statuses other than `active` are
   * included on purpose — a channel already marked `error` for a rejected PIN still has a token that
   * is worth extending, and refusing to renew it would turn one recoverable fault into two.
   */
  async listExpiringBefore(cutoff: Date): Promise<ChannelAccountRow[]> {
    const rows = await db
      .selectFrom('channel_accounts')
      .selectAll()
      .where('credential_expires_at', '<', cutoff)
      .where('status', '!=', 'revoked')
      .orderBy('credential_expires_at', 'asc')
      .execute();
    return rows.map(toRow);
  }

  /**
   * Point a row at a newly issued credential.
   *
   * Returns the ref it replaced so the caller can delete the superseded secret — the same contract
   * as {@link upsert}, for the same reason: two live tokens for one account means one of them is
   * unreachable and permanent.
   *
   * Clears `error_detail` and restores `active` ONLY when the row was in `error` for an expiry we
   * have now fixed. A channel marked `error` for a rejected registration PIN is left exactly as it
   * was — a new token does not register a number, and quietly reporting it healthy would send the
   * client back to an inbox that still cannot send.
   */
  async replaceCredential(params: {
    id: string;
    credentialRef: string;
    credentialExpiresAt: Date | null;
    clearExpiryError: boolean;
  }): Promise<string | null> {
    return db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom('channel_accounts')
        .select(['credential_ref', 'status', 'error_detail'])
        .where('id', '=', params.id)
        .forUpdate()
        .executeTakeFirst();
      if (existing === undefined) {
        // The account was disconnected while the exchange was in flight. The caller must delete the
        // secret it just created rather than leave it orphaned in the vault.
        return null;
      }

      await trx
        .updateTable('channel_accounts')
        .set({
          credential_ref: params.credentialRef,
          credential_expires_at: params.credentialExpiresAt,
          ...(params.clearExpiryError ? { status: 'active' as const, error_detail: null } : {}),
        })
        .where('id', '=', params.id)
        .execute();

      return existing.credential_ref === params.credentialRef ? null : existing.credential_ref;
    });
  }

  /**
   * Every ACTIVE account on one platform, across all tenants — the template sweep's only query.
   *
   * Un-scoped for the same reason {@link listExpiringBefore} is, and safe for the same reason: it
   * runs from a background timer, never from an authenticated route, and each row it returns carries
   * the `org_id` the work is then enqueued under. Nothing behind a request may call it.
   *
   * Only `active` here, unlike the expiry sweep. That one renews credentials for a broken channel on
   * purpose — a new token can fix it. This one reads templates through a credential the account has
   * already been marked broken for, which would spend a Graph call to be told the same thing again.
   */
  async listAllActive(platform: CommercePlatform): Promise<ChannelAccountRow[]> {
    const rows = await db
      .selectFrom('channel_accounts')
      .selectAll()
      .where('platform', '=', platform)
      .where('status', '=', 'active')
      .orderBy('connected_at', 'asc')
      .execute();
    return rows.map(toRow);
  }

  /** Remove the row. The caller deletes the vault secret; a dangling handle must not outlive this. */
  async remove(orgId: string, id: string): Promise<boolean> {
    const result = await db
      .deleteFrom('channel_accounts')
      .where('org_id', '=', orgId)
      .where('id', '=', id)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }
}

export const channelAccountRepository = new ChannelAccountRepository();
