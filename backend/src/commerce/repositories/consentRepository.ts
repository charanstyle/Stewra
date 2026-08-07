import type { Selectable } from 'kysely';
import type {
  CommercePlatform,
  ConsentPurpose,
  ConsentSource,
  ConsentState,
  ContactConsent,
  MessagingPolicy,
  Suppression,
  SuppressionReason,
} from '@stewra/shared-types';
import { db } from '../../database/index.js';
import type {
  CommerceContactConsentsTable,
  CommerceMessagingPoliciesTable,
  CommerceSuppressionsTable,
} from '../../database/types.js';

function toConsent(row: Selectable<CommerceContactConsentsTable>): ContactConsent {
  return {
    id: row.id,
    orgId: row.org_id,
    contactId: row.contact_id,
    platform: row.platform,
    purpose: row.purpose,
    state: row.state,
    source: row.source,
    evidence: row.evidence,
    recordedByUserId: row.recorded_by_user_id,
    recordedAt: row.recorded_at.toISOString(),
  };
}

function toSuppression(row: Selectable<CommerceSuppressionsTable>): Suppression {
  return {
    id: row.id,
    orgId: row.org_id,
    platform: row.platform,
    externalId: row.external_id,
    reason: row.reason,
    detail: row.detail,
    createdAt: row.created_at.toISOString(),
  };
}

/** Postgres hands back `time` as `HH:MM:SS`; the API contract is `HH:MM`. */
function toHhMm(pgTime: string): string {
  return pgTime.slice(0, 5);
}

function toPolicy(row: Selectable<CommerceMessagingPoliciesTable>): MessagingPolicy {
  return {
    orgId: row.org_id,
    timezone: row.timezone,
    quietHoursStart: toHhMm(row.quiet_hours_start),
    quietHoursEnd: toHhMm(row.quiet_hours_end),
    attestedAt: row.attested_at?.toISOString() ?? null,
    attestedByUserId: row.attested_by_user_id,
    attestationText: row.attestation_text,
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Consent history, the suppression list, and per-organization messaging policy — everything the send
 * gate reads before an organization is allowed to message a member of the public.
 *
 * Every method takes an `orgId` that `requireOrgMember` has already verified and filters on it,
 * including the ones that could have reached the row by primary key alone. A consent record fetched
 * without its tenant filter is a consent record that can be read — or worse, relied on — across a
 * tenant boundary, and this is the last table in the system where that should be possible.
 */
class ConsentRepository {
  /**
   * The platform and address behind a contact id, within one tenant.
   *
   * Both fields together, because the callers that need one almost always need the other: the
   * suppression list is keyed on `(platform, external_id)`, and a consent row records the platform
   * the person was actually reached on rather than one a request asserted.
   */
  async findContactIdentity(
    orgId: string,
    contactId: string,
  ): Promise<{ platform: CommercePlatform; externalId: string } | null> {
    const row = await db
      .selectFrom('commerce_contacts')
      .select(['platform', 'external_id'])
      .where('org_id', '=', orgId)
      .where('id', '=', contactId)
      .executeTakeFirst();
    return row === undefined ? null : { platform: row.platform, externalId: row.external_id };
  }

  /**
   * Append a consent record. There is no `updateConsent`, and there cannot be: the table's trigger
   * rejects UPDATE and DELETE outright. Withdrawal is an `opted_out` row appended after the fact.
   */
  async recordConsent(params: {
    orgId: string;
    contactId: string;
    platform: CommercePlatform;
    purpose: ConsentPurpose;
    state: ConsentState;
    source: ConsentSource;
    evidence: string;
    recordedByUserId: string | null;
  }): Promise<ContactConsent> {
    const row = await db
      .insertInto('commerce_contact_consents')
      .values({
        org_id: params.orgId,
        contact_id: params.contactId,
        platform: params.platform,
        purpose: params.purpose,
        state: params.state,
        source: params.source,
        evidence: params.evidence,
        recorded_by_user_id: params.recordedByUserId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toConsent(row);
  }

  /**
   * The consent currently on file for one purpose, or null when nothing has ever been recorded.
   *
   * Null means "no record", which is NOT the same as `opted_out` and must not be collapsed into it
   * by the caller either — the send gate refuses both, but an operator looking at a contact needs to
   * tell "they said no" from "we never asked".
   */
  async currentConsent(
    orgId: string,
    contactId: string,
    purpose: ConsentPurpose,
  ): Promise<ContactConsent | null> {
    const row = await db
      .selectFrom('commerce_contact_consents')
      .selectAll()
      .where('org_id', '=', orgId)
      .where('contact_id', '=', contactId)
      .where('purpose', '=', purpose)
      // Ties broken by id so the answer is deterministic: an opt-in and an opt-out written in the
      // same transaction share a `now()`, and a gate that picks arbitrarily between them is a gate
      // that sometimes sends.
      .orderBy('recorded_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row === undefined ? null : toConsent(row);
  }

  /** The full audit trail for one contact, newest first — what an operator is shown on a complaint. */
  async listConsentHistory(orgId: string, contactId: string): Promise<ContactConsent[]> {
    const rows = await db
      .selectFrom('commerce_contact_consents')
      .selectAll()
      .where('org_id', '=', orgId)
      .where('contact_id', '=', contactId)
      .orderBy('recorded_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    return rows.map(toConsent);
  }

  /**
   * Block an address. Idempotent, and the FIRST reason wins on conflict.
   *
   * That direction is deliberate. If someone opted out and a later bulk import re-adds them as
   * `manual`, the record that matters is the one where they asked to be left alone — overwriting it
   * would erase the only evidence that the opt-out ever happened.
   */
  async suppress(params: {
    orgId: string;
    platform: CommercePlatform;
    externalId: string;
    reason: SuppressionReason;
    detail: string | null;
  }): Promise<Suppression> {
    const row = await db
      .insertInto('commerce_suppressions')
      .values({
        org_id: params.orgId,
        platform: params.platform,
        external_id: params.externalId,
        reason: params.reason,
        detail: params.detail,
      })
      .onConflict((oc) =>
        oc.columns(['org_id', 'platform', 'external_id']).doUpdateSet((eb) => ({
          // A no-op assignment rather than DO NOTHING, which returns no row at all. Writing the
          // column back to itself keeps the original reason and still yields the existing row.
          reason: eb.ref('commerce_suppressions.reason'),
        })),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return toSuppression(row);
  }

  async isSuppressed(
    orgId: string,
    platform: CommercePlatform,
    externalId: string,
  ): Promise<Suppression | null> {
    const row = await db
      .selectFrom('commerce_suppressions')
      .selectAll()
      .where('org_id', '=', orgId)
      .where('platform', '=', platform)
      .where('external_id', '=', externalId)
      .executeTakeFirst();
    return row === undefined ? null : toSuppression(row);
  }

  /** Lift a block. Returns false when there was nothing to lift, rather than pretending there was. */
  async lift(orgId: string, platform: CommercePlatform, externalId: string): Promise<boolean> {
    const result = await db
      .deleteFrom('commerce_suppressions')
      .where('org_id', '=', orgId)
      .where('platform', '=', platform)
      .where('external_id', '=', externalId)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  async listSuppressions(orgId: string, limit: number): Promise<Suppression[]> {
    const rows = await db
      .selectFrom('commerce_suppressions')
      .selectAll()
      .where('org_id', '=', orgId)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .execute();
    return rows.map(toSuppression);
  }

  /** The org's messaging policy, or null when it has never set one — which means it cannot broadcast. */
  async findPolicy(orgId: string): Promise<MessagingPolicy | null> {
    const row = await db
      .selectFrom('commerce_messaging_policies')
      .selectAll()
      .where('org_id', '=', orgId)
      .executeTakeFirst();
    return row === undefined ? null : toPolicy(row);
  }

  /**
   * Set quiet hours. Deliberately does NOT touch the attestation columns: changing when you send is
   * an operational edit, signing a statement about how you obtained consent is not, and an upsert
   * that silently carried the old signature forward would let a policy rewrite inherit it.
   */
  async upsertQuietHours(params: {
    orgId: string;
    timezone: string;
    quietHoursStart: string;
    quietHoursEnd: string;
  }): Promise<MessagingPolicy> {
    const row = await db
      .insertInto('commerce_messaging_policies')
      .values({
        org_id: params.orgId,
        timezone: params.timezone,
        quiet_hours_start: params.quietHoursStart,
        quiet_hours_end: params.quietHoursEnd,
        updated_at: new Date(),
      })
      .onConflict((oc) =>
        oc.column('org_id').doUpdateSet((eb) => ({
          timezone: eb.ref('excluded.timezone'),
          quiet_hours_start: eb.ref('excluded.quiet_hours_start'),
          quiet_hours_end: eb.ref('excluded.quiet_hours_end'),
          updated_at: eb.ref('excluded.updated_at'),
        })),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return toPolicy(row);
  }

  /**
   * Record the lawful-opt-in attestation against an EXISTING policy row.
   *
   * Returns null when the org has no policy yet, rather than creating one: an attestation without
   * quiet hours would leave the org half-configured while reading as signed, and the signature is
   * the one field in this schema that must never be produced as a side effect.
   */
  async attest(params: {
    orgId: string;
    attestedByUserId: string;
    attestationText: string;
  }): Promise<MessagingPolicy | null> {
    const row = await db
      .updateTable('commerce_messaging_policies')
      .set({
        attested_at: new Date(),
        attested_by_user_id: params.attestedByUserId,
        attestation_text: params.attestationText,
        updated_at: new Date(),
      })
      .where('org_id', '=', params.orgId)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? null : toPolicy(row);
  }
}

export const consentRepository = new ConsentRepository();
