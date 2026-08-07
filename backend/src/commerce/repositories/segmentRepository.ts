import { sql } from 'kysely';
import type {
  AudienceBlockReason,
  AudienceMember,
  CommercePlatform,
  CommerceSegment,
  SegmentDefinition,
} from '@stewra/shared-types';
import { OUTBOUND_CAPABLE_PLATFORMS } from '@stewra/shared-types';
import { db } from '../../database/index.js';
import { compileSegment, parseSegmentDefinition } from '../services/segmentQuery.js';

interface SegmentRow {
  id: string;
  org_id: string;
  name: string;
  description: string | null;
  definition: unknown;
  created_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
}

function toSegment(row: SegmentRow): CommerceSegment {
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    description: row.description,
    // Re-validated on the way out, so a row written under an older rule shape refuses loudly here
    // rather than compiling into a query that selects the wrong people.
    definition: parseSegmentDefinition(row.definition, `Segment "${row.name}"`),
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toMember(row: {
  id: string;
  platform: CommercePlatform;
  external_id: string;
  display_name: string | null;
  phone_e164: string | null;
  blocked_reason: AudienceBlockReason | null;
}): AudienceMember {
  return {
    contactId: row.id,
    platform: row.platform,
    externalId: row.external_id,
    displayName: row.display_name,
    phoneE164: row.phone_e164,
    blockedReason: row.blocked_reason,
  };
}

/**
 * Why each selected contact cannot be reached, as one CASE over the joins in `audienceQuery` below.
 *
 * The ORDER of the branches is the answer's meaning. Suppression comes first because it is the block
 * a person asked for themselves, and reporting a suppressed contact as merely "no consent" would
 * invite an operator to go and collect one. Everything after it is a fixable gap; the first branch is
 * not ours to fix.
 *
 * Computed in SQL rather than per contact in Node, and that is not only about speed: a per-contact
 * loop calling the consent gate would be a second implementation of the same rules, free to drift
 * from `consentService.assertMaySend` in exactly the direction that sends more messages.
 *
 * The outbound-capable list comes from shared types rather than a literal, so the day Instagram
 * gains business-initiated sends this stops being wrong in one place instead of several.
 */
const BLOCKED_REASON = sql<AudienceBlockReason | null>`case
  when s.id is not null then 'suppressed'
  when c.platform <> all(${sql.val([...OUTBOUND_CAPABLE_PLATFORMS])}::text[]) then 'platform_inbound_only'
  when cons.state is null then 'no_marketing_consent'
  when cons.state = 'opted_out' then 'marketing_opted_out'
  else null
end`;

/**
 * Contacts, their suppression row if any, and their current marketing consent.
 *
 * A LATERAL for the consent, because "newest row per contact" is a per-row LIMIT 1. Its ordering is
 * character-for-character the one `consentRepository.currentConsent` uses, including the tie-break on
 * id — two different answers to "is this person opted in" is the one discrepancy this feature cannot
 * afford, and a segment that disagrees with the send gate would show an audience larger than what
 * actually goes out.
 */
function audienceQuery(orgId: string, definition: SegmentDefinition) {
  return db
    .selectFrom('commerce_contacts as c')
    .leftJoin('commerce_suppressions as s', (join) =>
      join
        .onRef('s.org_id', '=', 'c.org_id')
        .onRef('s.platform', '=', 'c.platform')
        .onRef('s.external_id', '=', 'c.external_id'),
    )
    .leftJoinLateral(
      (eb) =>
        eb
          .selectFrom('commerce_contact_consents as cc')
          .select('cc.state')
          .whereRef('cc.contact_id', '=', 'c.id')
          .where('cc.purpose', '=', 'marketing')
          .orderBy('cc.recorded_at', 'desc')
          .orderBy('cc.id', 'desc')
          .limit(1)
          .as('cons'),
      (join) => join.onTrue(),
    )
    .where('c.org_id', '=', orgId)
    .where(compileSegment(definition, 'c'));
}

/**
 * Segments, and the audiences they resolve to.
 *
 * Nothing here stores a member list. Every audience read recompiles the saved rule and runs it, so
 * the answer is always against consent as it stands right now — see `segmentQuery.ts`.
 */
class SegmentRepository {
  async list(orgId: string): Promise<CommerceSegment[]> {
    const rows = await db
      .selectFrom('commerce_segments')
      .selectAll()
      .where('org_id', '=', orgId)
      .orderBy('name', 'asc')
      .execute();
    return rows.map((row) => toSegment(row));
  }

  async findById(orgId: string, segmentId: string): Promise<CommerceSegment | null> {
    const row = await db
      .selectFrom('commerce_segments')
      .selectAll()
      .where('org_id', '=', orgId)
      .where('id', '=', segmentId)
      .executeTakeFirst();
    return row === undefined ? null : toSegment(row);
  }

  async create(params: {
    orgId: string;
    name: string;
    description: string | null;
    definition: SegmentDefinition;
    createdByUserId: string;
  }): Promise<CommerceSegment> {
    const row = await db
      .insertInto('commerce_segments')
      .values({
        org_id: params.orgId,
        name: params.name,
        description: params.description,
        definition: JSON.stringify(params.definition),
        created_by_user_id: params.createdByUserId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toSegment(row);
  }

  async update(params: {
    orgId: string;
    segmentId: string;
    name: string;
    description: string | null;
    definition: SegmentDefinition;
  }): Promise<CommerceSegment | null> {
    const row = await db
      .updateTable('commerce_segments')
      .set({
        name: params.name,
        description: params.description,
        definition: JSON.stringify(params.definition),
        updated_at: new Date(),
      })
      .where('org_id', '=', params.orgId)
      .where('id', '=', params.segmentId)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? null : toSegment(row);
  }

  async delete(orgId: string, segmentId: string): Promise<boolean> {
    const result = await db
      .deleteFrom('commerce_segments')
      .where('org_id', '=', orgId)
      .where('id', '=', segmentId)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  /**
   * Which segments' rules mention a tag by name.
   *
   * Asked before a tag is deleted. A `has` rule left pointing at a deleted label matches nobody and a
   * `not_has` rule matches everybody, and neither says anything at send time — the campaign simply
   * reaches the wrong number of people. Refusing the delete is the only version of this that fails
   * where someone is looking.
   */
  async segmentsReferencingTag(orgId: string, tagName: string): Promise<string[]> {
    const rows = await db
      .selectFrom('commerce_segments')
      .select('name')
      .where('org_id', '=', orgId)
      .where(
        sql<boolean>`exists (
          select 1
          from jsonb_array_elements(definition -> 'rules') r
          where r ->> 'type' = 'tag' and lower(r ->> 'tag') = lower(${tagName})
        )`,
      )
      .execute();
    return rows.map((row) => row.name);
  }

  /** How many contacts the rule selects, split by whether marketing can actually reach them. */
  async countAudience(
    orgId: string,
    definition: SegmentDefinition,
  ): Promise<{ total: number; blocked: Record<AudienceBlockReason, number> }> {
    // Grouped over a subquery rather than by repeating the CASE in a GROUP BY clause. Repeating it
    // looks equivalent and is not: each render of the expression binds its parameters at fresh
    // positions, so Postgres compares `case ... $2 ...` against `case ... $5 ...`, decides they are
    // different expressions, and rejects the whole statement. Naming the column once removes the
    // question.
    const rows = await db
      .selectFrom(
        audienceQuery(orgId, definition).select(BLOCKED_REASON.as('blocked_reason')).as('a'),
      )
      .select('a.blocked_reason')
      .select(db.fn.countAll<string>().as('count'))
      .groupBy('a.blocked_reason')
      .execute();

    // Every reason present at zero. A caller asking "how many were suppressed" must be able to read
    // the answer directly; making it tell zero from a missing key is how a check reports healthy.
    const blocked: Record<AudienceBlockReason, number> = {
      suppressed: 0,
      platform_inbound_only: 0,
      no_marketing_consent: 0,
      marketing_opted_out: 0,
    };
    let total = 0;
    for (const row of rows) {
      const count = Number(row.count);
      total += count;
      if (row.blocked_reason !== null) blocked[row.blocked_reason] = count;
    }
    return { total, blocked };
  }

  /**
   * The members themselves, paged.
   *
   * Ordered by `created_at, id` rather than `created_at` alone. Contacts imported in one batch share
   * a timestamp to the microsecond, and an unstable sort under OFFSET paging silently repeats some
   * rows and skips others — which for a broadcast means messaging some people twice and others never.
   */
  async listAudience(params: {
    orgId: string;
    definition: SegmentDefinition;
    limit: number;
    offset: number;
    sendableOnly: boolean;
  }): Promise<AudienceMember[]> {
    let query = audienceQuery(params.orgId, params.definition)
      .select(['c.id', 'c.platform', 'c.external_id', 'c.display_name', 'c.phone_e164'])
      .select(BLOCKED_REASON.as('blocked_reason'))
      .orderBy('c.created_at', 'asc')
      .orderBy('c.id', 'asc')
      .limit(params.limit)
      .offset(params.offset);

    if (params.sendableOnly) {
      // The CASE is repeated rather than referenced by its alias — SQL cannot see a select alias in
      // its own WHERE, and Postgres would reject the shorter version outright.
      query = query.where(sql<boolean>`${BLOCKED_REASON} is null`);
    }

    const rows = await query.execute();
    return rows.map((row) => toMember(row));
  }

  /**
   * Sendable members grouped by the first three digits of their phone number, for the cost forecast.
   *
   * Three digits because no E.164 calling code is longer; the service folds each group onto its
   * actual code (`callingCodes.ts`), so `+4479…` and `+4915…` both land under their own countries
   * without this query knowing the plan. Grouped in SQL rather than paging every member into Node —
   * a forecast that walks a 100k audience to draw one table is a preview nobody waits for.
   *
   * The null key carries members with no usable number. Counted, not dropped: they are part of what
   * the campaign will attempt, and a forecast that quietly omits them understates the send.
   */
  async countSendableByPhonePrefix(
    orgId: string,
    definition: SegmentDefinition,
  ): Promise<Array<{ prefix: string | null; count: number }>> {
    const prefix = sql<string | null>`case
      when c.phone_e164 is null then null
      else substring(c.phone_e164 from 2 for 3)
    end`;
    const rows = await db
      .selectFrom(
        audienceQuery(orgId, definition)
          .select(prefix.as('prefix'))
          .where(sql<boolean>`${BLOCKED_REASON} is null`)
          .as('a'),
      )
      .select('a.prefix')
      .select(db.fn.countAll<string>().as('count'))
      .groupBy('a.prefix')
      .execute();
    return rows.map((row) => ({ prefix: row.prefix, count: Number(row.count) }));
  }
}

export const segmentRepository = new SegmentRepository();
