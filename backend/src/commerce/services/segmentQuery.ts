import { sql } from 'kysely';
import type { RawBuilder } from 'kysely';
import { z } from 'zod';
import type { SegmentDefinition, SegmentRule } from '@stewra/shared-types';
import { COMMERCE_PLATFORMS, CONSENT_PURPOSES, CONSENT_STATES, SEGMENT_MATCH_MODES } from '@stewra/shared-types';
import { ValidationError } from '../../utils/errors.js';

/**
 * The only place a stored segment rule becomes SQL.
 *
 * A segment is a rule, not a member list, so this runs every time an audience is needed — on preview,
 * on the member list, and on the enqueue pass of every broadcast. That is the point: the audience is
 * recomputed against current consent each time, and a contact who opted out an hour ago is gone from
 * it without anyone having to remember to refresh anything.
 *
 * Two properties this file has to hold on to:
 *
 * 1. **Every value is a bound parameter.** Nothing a client typed is ever concatenated into the
 *    statement — not a tag name, not an attribute key, not a comparison value. `sql` templates
 *    parameterize interpolations, and the only interpolation that is not a parameter is `sql.ref` on
 *    an alias this module controls.
 * 2. **A definition it cannot understand throws.** Definitions are re-validated on the way OUT of the
 *    database as well as in. A row written under an older rule shape must fail loudly the next time
 *    it is used, because the alternative is a campaign quietly selecting the wrong people — and the
 *    people who find out are the ones who receive it.
 */

/** How many rules one segment may carry. A bound on query cost, and on what a person can still read. */
const MAX_RULES = 20;

const isoDate = z
  .string()
  .min(1)
  .max(40)
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: 'must be an ISO date' });

/**
 * Attribute keys are the client's own field names, so the shape is theirs — but not unbounded. The
 * character class excludes anything that would make a key indistinguishable from a path expression
 * later, if typed fields ever arrive.
 */
export const attributeKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_.-]+$/, 'attribute keys may contain letters, digits, dot, dash and underscore');

/** Shared by rule values and stored attribute values, so every stored value stays comparable. */
export const ATTRIBUTE_VALUE_MAX = 500;

const ruleSchema = z.union([
  z.strictObject({
    type: z.literal('tag'),
    op: z.enum(['has', 'not_has']),
    tag: z.string().min(1).max(64),
  }),
  z.strictObject({
    type: z.literal('attribute'),
    key: attributeKeySchema,
    op: z.enum(['eq', 'neq', 'contains']),
    value: z.string().min(1).max(ATTRIBUTE_VALUE_MAX),
  }),
  z.strictObject({
    type: z.literal('attribute'),
    key: attributeKeySchema,
    op: z.enum(['exists', 'not_exists']),
  }),
  z.strictObject({
    type: z.literal('consent'),
    purpose: z.enum(CONSENT_PURPOSES),
    state: z.union([z.enum(CONSENT_STATES), z.literal('none')]),
  }),
  z.strictObject({ type: z.literal('platform'), value: z.enum(COMMERCE_PLATFORMS) }),
  z.strictObject({
    type: z.literal('created'),
    op: z.enum(['before', 'after']),
    value: isoDate,
  }),
  z.strictObject({
    type: z.literal('last_message'),
    op: z.enum(['before', 'after']),
    value: isoDate,
  }),
  z.strictObject({ type: z.literal('last_message'), op: z.literal('never') }),
]);

/**
 * At least one rule, always.
 *
 * An empty list would mean "all of nothing", which every boolean algebra says is TRUE — a segment
 * with no rules would select the entire contact list, and it would do so while looking like an
 * unfinished draft. That is the cheapest possible way to send a campaign to people nobody meant to
 * include. An organization that genuinely wants everyone writes the rule that says so
 * (`consent marketing opted_in`), which is also the audience it is actually allowed to have.
 */
export const segmentDefinitionSchema = z.strictObject({
  match: z.enum(SEGMENT_MATCH_MODES),
  rules: z.array(ruleSchema).min(1).max(MAX_RULES),
});

/**
 * Validate a definition read back from `jsonb`.
 *
 * Separate from the request-body parse on purpose. The stored row is the one that will still be here
 * after the rule shape changes, and this is where that shows up — as a refusal naming the segment,
 * rather than as a silently smaller audience.
 */
export function parseSegmentDefinition(value: unknown, context: string): SegmentDefinition {
  const result = segmentDefinitionSchema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(
      `${context} has a definition this version cannot evaluate: ${result.error.issues
        .map((issue) => `${issue.path.join('.')} ${issue.message}`)
        .join('; ')}`,
    );
  }
  return result.data;
}

/**
 * One rule as a boolean SQL fragment, correlated to the contact row aliased `alias`.
 *
 * The alias is supplied by the caller and is always a literal this module's callers control — it is
 * the one interpolation here that is an identifier rather than a parameter.
 */
/**
 * The attribute rules, split out so the caller's `case 'attribute'` is a single return.
 *
 * Every branch here returns and TypeScript proves the set exhaustive, but a `switch` nested inside a
 * `case` reads as a fallthrough to anything checking syntax rather than types. Lifting it is cheaper
 * than a suppression and leaves the outer switch easier to scan.
 */
function attributeRuleToSql(
  rule: Extract<SegmentRule, { type: 'attribute' }>,
  alias: string,
): RawBuilder<boolean> {
  const attributes = sql.ref(`${alias}.attributes`);
  const field = sql<string | null>`${attributes} ->> ${rule.key}`;
  switch (rule.op) {
    case 'eq':
      return sql<boolean>`${field} = ${rule.value}`;
    // IS DISTINCT FROM rather than `<>`, so a contact who has no such field at all counts as
    // "not pro". `<>` against NULL is NULL, which is not TRUE, which would silently drop every
    // contact missing the field from a rule whose plain reading includes them.
    case 'neq':
      return sql<boolean>`${field} is distinct from ${rule.value}`;
    // strpos rather than ILIKE: the needle is a client-typed string, and `%` or `_` inside it would
    // otherwise act as wildcards nobody asked for.
    case 'contains':
      return sql<boolean>`strpos(lower(coalesce(${field}, '')), lower(${rule.value})) > 0`;
    case 'exists':
      return sql<boolean>`jsonb_exists(${attributes}, ${rule.key})`;
    case 'not_exists':
      return sql<boolean>`not jsonb_exists(${attributes}, ${rule.key})`;
  }
}

function ruleToSql(rule: SegmentRule, alias: string): RawBuilder<boolean> {
  const contactId = sql.ref(`${alias}.id`);

  switch (rule.type) {
    case 'tag': {
      // Matched by name, case-insensitively, to agree with the unique index on `lower(name)`.
      const carries = sql<boolean>`exists (
        select 1
        from commerce_contact_tags ct
        join commerce_tags t on t.id = ct.tag_id
        where ct.contact_id = ${contactId}
          and lower(t.name) = lower(${rule.tag})
      )`;
      return rule.op === 'has' ? carries : sql<boolean>`not ${carries}`;
    }

    case 'attribute':
      return attributeRuleToSql(rule, alias);

    case 'consent': {
      // The newest row for this purpose, matching `consentRepository.currentConsent` exactly —
      // including the tie-break on id, so a rule and the send gate can never disagree about a contact
      // whose opt-in and opt-out share a timestamp.
      const current = sql<string | null>`(
        select cc.state
        from commerce_contact_consents cc
        where cc.contact_id = ${contactId}
          and cc.purpose = ${rule.purpose}
        order by cc.recorded_at desc, cc.id desc
        limit 1
      )`;
      // `none` means nothing was ever recorded, which is a different fact from `opted_out` and is the
      // audience a re-permission campaign is actually aimed at.
      if (rule.state === 'none') return sql<boolean>`${current} is null`;
      return sql<boolean>`${current} = ${rule.state}`;
    }

    case 'platform':
      return sql<boolean>`${sql.ref(`${alias}.platform`)} = ${rule.value}`;

    case 'created': {
      const at = new Date(rule.value);
      return rule.op === 'before'
        ? sql<boolean>`${sql.ref(`${alias}.created_at`)} < ${at}`
        : sql<boolean>`${sql.ref(`${alias}.created_at`)} > ${at}`;
    }

    case 'last_message': {
      // Across every thread the contact has, on any connected number — "last heard from" is a fact
      // about the person, not about which of the business's numbers they happened to use.
      const latest = sql<Date | null>`(
        select max(cv.last_message_at)
        from commerce_conversations cv
        where cv.contact_id = ${contactId}
      )`;
      if (rule.op === 'never') return sql<boolean>`${latest} is null`;
      const at = new Date(rule.value);
      // A contact who has never messaged is NOT "last messaged before January" — they have no last
      // message at all. NULL falls out of both comparisons on its own, which is the honest answer.
      return rule.op === 'before' ? sql<boolean>`${latest} < ${at}` : sql<boolean>`${latest} > ${at}`;
    }
  }
}

/**
 * The whole definition as one boolean fragment, to be ANDed onto an org-scoped contact query.
 *
 * This never emits the tenant filter itself. The caller supplies `org_id = ...` unconditionally, so a
 * rule can never widen the scope past the organization that owns the segment — the tenancy predicate
 * is not something a stored definition gets a say in.
 */
export function compileSegment(definition: SegmentDefinition, alias: string): RawBuilder<boolean> {
  const parts = definition.rules.map((rule) => ruleToSql(rule, alias));
  const joined = sql.join(parts, definition.match === 'all' ? sql` and ` : sql` or `);
  return sql<boolean>`(${joined})`;
}
