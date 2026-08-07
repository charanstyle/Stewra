import type {
  AudienceMember,
  AudiencePreview,
  CommerceSegment,
  CommerceTag,
  SegmentDefinition,
} from '@stewra/shared-types';
import { AUDIENCE_BLOCK_REASONS } from '@stewra/shared-types';
import { broadcastRepository } from '../repositories/broadcastRepository.js';
import { contactRepository } from '../repositories/contactRepository.js';
import type { ContactWithTags } from '../repositories/contactRepository.js';
import { segmentRepository } from '../repositories/segmentRepository.js';
import { consentRepository } from '../repositories/consentRepository.js';
import { isUniqueViolation } from '../../database/pgErrors.js';
import { ATTRIBUTE_VALUE_MAX, attributeKeySchema } from './segmentQuery.js';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';

/**
 * How many client-defined fields one contact may carry.
 *
 * A cap rather than none, because `attributes` is indexed with GIN and every row is read whole on
 * every segment evaluation. The number is generous for the thing it models — a business's own notes
 * about a customer — and low enough that an import bug filling it with a field per order is refused
 * at the write instead of discovered as a slow query weeks later.
 */
const MAX_ATTRIBUTES = 50;

/**
 * Contacts, labels and segments — everything that answers "who is this going to" before a send.
 *
 * The rule this file exists to keep: a segment names people, it never grants permission to message
 * them. `previewSegment` reports how many of the selected contacts marketing can actually reach, and
 * that number is advisory even so — `consentService.assertMaySend` is re-run per recipient at send
 * time, because a preview is a fact about a moment that has already passed by the time anyone acts
 * on it.
 */
class AudienceService {
  async listContacts(params: {
    orgId: string;
    limit: number;
    search?: string;
    tag?: string;
  }): Promise<ContactWithTags[]> {
    return contactRepository.list(params);
  }

  async getContact(orgId: string, contactId: string): Promise<ContactWithTags> {
    const found = await contactRepository.findById(orgId, contactId);
    if (found === null) throw new NotFoundError('Contact not found');
    return found;
  }

  /**
   * Apply an attribute patch: keys with a value are set, keys with null are removed.
   *
   * Keys are validated against the same schema the segment compiler accepts. A key that no rule could
   * ever reference is a field the client can fill in and then never target, which looks like the
   * feature working right up until the campaign that needed it.
   */
  async updateContact(params: {
    orgId: string;
    contactId: string;
    /** `undefined` leaves the name alone; `null` clears it. */
    displayName: string | null | undefined;
    attributes: Readonly<Record<string, string | null>> | undefined;
  }): Promise<ContactWithTags> {
    const existing = await this.getContact(params.orgId, params.contactId);

    const setAttributes: Record<string, string> = {};
    const removeAttributeKeys: string[] = [];
    for (const [key, value] of Object.entries(params.attributes ?? {})) {
      const parsedKey = attributeKeySchema.safeParse(key);
      if (!parsedKey.success) {
        throw new ValidationError(
          `"${key}" is not a usable attribute name: ${parsedKey.error.issues[0]?.message ?? 'invalid'}`,
        );
      }
      if (value === null) {
        removeAttributeKeys.push(key);
        continue;
      }
      if (value.length > ATTRIBUTE_VALUE_MAX) {
        throw new ValidationError(
          `Attribute "${key}" is longer than ${ATTRIBUTE_VALUE_MAX} characters.`,
        );
      }
      setAttributes[key] = value;
    }

    const resulting = new Set(Object.keys(existing.contact.attributes));
    for (const key of removeAttributeKeys) resulting.delete(key);
    for (const key of Object.keys(setAttributes)) resulting.add(key);
    if (resulting.size > MAX_ATTRIBUTES) {
      throw new ValidationError(
        `A contact may carry at most ${MAX_ATTRIBUTES} attributes; this change would leave ${resulting.size}.`,
      );
    }

    const updated = await contactRepository.update({
      orgId: params.orgId,
      contactId: params.contactId,
      displayName: params.displayName,
      setAttributes,
      removeAttributeKeys,
    });
    if (!updated) throw new NotFoundError('Contact not found');
    return this.getContact(params.orgId, params.contactId);
  }

  /** Label a contact, creating the tag on first use. */
  async addContactTag(orgId: string, contactId: string, name: string): Promise<CommerceTag> {
    const trimmed = name.trim();
    if (trimmed === '') throw new ValidationError('A tag needs a name.');
    // Confirms the contact belongs to this org before a tag is created for it — otherwise a caller
    // could mint tags in their own org by naming a stranger's contact id.
    await this.getContact(orgId, contactId);
    const tag = await contactRepository.upsertTag(orgId, trimmed);
    await contactRepository.attachTag(orgId, contactId, tag.id);
    return tag;
  }

  async removeContactTag(orgId: string, contactId: string, tagId: string): Promise<boolean> {
    return contactRepository.detachTag(orgId, contactId, tagId);
  }

  async listTags(orgId: string): Promise<CommerceTag[]> {
    return contactRepository.listTags(orgId);
  }

  /**
   * Delete a label — refused while any segment's rules still name it.
   *
   * The refusal is the feature. A `has` rule pointing at a deleted tag matches nobody and a `not_has`
   * rule matches everybody; the campaign then reaches the wrong number of people and nothing in the
   * send path has any way to know. Naming the segments in the error is what makes the refusal
   * actionable rather than merely obstructive.
   */
  async deleteTag(orgId: string, tagId: string): Promise<boolean> {
    const tag = await contactRepository.findTagById(orgId, tagId);
    if (tag === null) throw new NotFoundError('Tag not found');

    const referencing = await segmentRepository.segmentsReferencingTag(orgId, tag.name);
    if (referencing.length > 0) {
      throw new ConflictError(
        `"${tag.name}" is used by ${referencing.length} segment(s): ${referencing.join(', ')}. ` +
          'Edit those segments first — a rule left pointing at a deleted tag silently changes who a ' +
          'campaign reaches.',
      );
    }
    return contactRepository.deleteTag(orgId, tagId);
  }

  async listSegments(orgId: string): Promise<CommerceSegment[]> {
    return segmentRepository.list(orgId);
  }

  async getSegment(orgId: string, segmentId: string): Promise<CommerceSegment> {
    const segment = await segmentRepository.findById(orgId, segmentId);
    if (segment === null) throw new NotFoundError('Segment not found');
    return segment;
  }

  async createSegment(params: {
    orgId: string;
    name: string;
    description: string | null;
    definition: SegmentDefinition;
    createdByUserId: string;
  }): Promise<CommerceSegment> {
    try {
      return await segmentRepository.create(params);
    } catch (error) {
      // The unique index is the check, not a prior SELECT: two people saving "Lapsed" at the same
      // moment would both pass a pre-check and one would still fail here.
      if (isUniqueViolation(error)) {
        throw new ConflictError(`A segment called "${params.name}" already exists.`);
      }
      throw error;
    }
  }

  async updateSegment(params: {
    orgId: string;
    segmentId: string;
    name: string;
    description: string | null;
    definition: SegmentDefinition;
  }): Promise<CommerceSegment> {
    try {
      const segment = await segmentRepository.update(params);
      if (segment === null) throw new NotFoundError('Segment not found');
      return segment;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(`A segment called "${params.name}" already exists.`);
      }
      throw error;
    }
  }

  /**
   * Delete a segment — refused while a broadcast that can still send points at it.
   *
   * The RESTRICT foreign key would refuse anyway, but with a constraint name; this refusal names
   * the campaigns, which is the sentence the operator can act on. Completed and cancelled
   * broadcasts hold nothing: their audience is already a materialized ledger.
   */
  async deleteSegment(orgId: string, segmentId: string): Promise<boolean> {
    const blocking = await broadcastRepository.broadcastsUsingSegment(orgId, segmentId);
    if (blocking.length > 0) {
      throw new ConflictError(
        `This segment is used by ${blocking.length} broadcast(s) that have not finished: ` +
          `${blocking.join(', ')}. Cancel them first.`,
      );
    }
    return segmentRepository.delete(orgId, segmentId);
  }

  /**
   * What a definition would reach right now: totals, per-reason blocks, and a sample.
   *
   * `total` and `sendable` are both reported because a client reads the first one as the size of
   * their campaign. If a third of the audience has no marketing consent, the moment to learn that is
   * while looking at the rule — not from the delivery report afterwards, when the money has been
   * spent on the part that did send.
   */
  async previewSegment(
    orgId: string,
    definition: SegmentDefinition,
    sampleLimit: number,
  ): Promise<AudiencePreview> {
    const [counts, sample, policy] = await Promise.all([
      segmentRepository.countAudience(orgId, definition),
      segmentRepository.listAudience({
        orgId,
        definition,
        limit: sampleLimit,
        offset: 0,
        sendableOnly: false,
      }),
      consentRepository.findPolicy(orgId),
    ]);

    const blockedTotal = AUDIENCE_BLOCK_REASONS.reduce(
      (sum, reason) => sum + counts.blocked[reason],
      0,
    );

    // Absence is the refusing state, here as everywhere in this feature: no policy and no attestation
    // are each a reason nothing may go out, not a gap to read past.
    const orgBlockedReason =
      policy === null ? 'no_messaging_policy' : policy.attestedAt === null ? 'not_attested' : null;

    return {
      total: counts.total,
      sendable: counts.total - blockedTotal,
      blocked: counts.blocked,
      orgBlockedReason,
      sample,
    };
  }

  async listSegmentMembers(params: {
    orgId: string;
    segmentId: string;
    limit: number;
    offset: number;
    sendableOnly: boolean;
  }): Promise<AudienceMember[]> {
    const segment = await this.getSegment(params.orgId, params.segmentId);
    return segmentRepository.listAudience({
      orgId: params.orgId,
      definition: segment.definition,
      limit: params.limit,
      offset: params.offset,
      sendableOnly: params.sendableOnly,
    });
  }
}

export const audienceService = new AudienceService();
