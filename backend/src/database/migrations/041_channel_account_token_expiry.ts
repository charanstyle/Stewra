import type { Kysely } from 'kysely';
import type { Database } from '../types.js';

/**
 * WHEN a connected client's WhatsApp credential stops working.
 *
 * Embedded Signup does not hand out a permanent credential. The only Meta login configuration that
 * grants the full set of WhatsApp management permissions is "WhatsApp Embedded Signup Configuration
 * With 60 Expiration Token" — the token it issues dies 60 days after the client approves the dialog.
 * Migration 039 stored the token and never stored that fact, which means the first sign of an expiry
 * would have been sends failing for a business that was told it was connected.
 *
 * A nullable column, deliberately. Meta reports `expires_at: 0` for a credential that never expires,
 * and a future login configuration may well issue one; NULL is the honest record of "this credential
 * has no expiry", and it is different from "we have not asked". Nothing reads this column as a
 * boolean — the sweep filters on `IS NOT NULL` so a non-expiring token is never touched.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .alterTable('channel_accounts')
    .addColumn('credential_expires_at', 'timestamptz')
    .execute();

  // The sweep's only query: rows whose credential dies before some cutoff. Partial, because the
  // rows worth scanning are exactly the ones with an expiry, and on a table where most accounts may
  // eventually be non-expiring a full index would be mostly dead weight.
  await db.schema
    .createIndex('idx_channel_accounts_credential_expiry')
    .on('channel_accounts')
    .column('credential_expires_at')
    .where('credential_expires_at', 'is not', null)
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropIndex('idx_channel_accounts_credential_expiry').execute();
  await db.schema.alterTable('channel_accounts').dropColumn('credential_expires_at').execute();
}
