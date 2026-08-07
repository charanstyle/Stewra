import type {
  CommercePlatform,
  ConsentPurpose,
  ConsentSource,
  ContactConsent,
  MessagingPolicy,
  Suppression,
  SuppressionReason,
} from '@stewra/shared-types';
import type { InboundReferral } from './inbound/types.js';
import { findOptinToken } from './optinLinkService.js';
import { consentRepository } from '../repositories/consentRepository.js';
import { optinLinkRepository } from '../repositories/optinLinkRepository.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

/** Longest suppression page a caller can ask for. A behaviour knob, not a target. */
const MAX_SUPPRESSION_PAGE = 500;

/**
 * Words a customer can send to stop hearing from a business, matched case-insensitively against the
 * whole trimmed message.
 *
 * Whole-message rather than substring on purpose: "I'd like to stop by on Tuesday" contains "stop"
 * and is not an opt-out, and silently unsubscribing someone who was trying to book an appointment is
 * a worse failure than missing a stray phrasing. Meta also honours these itself at the platform
 * level; recording our own row means the business's list is right even before Meta tells us.
 */
const OPT_OUT_KEYWORDS = new Set([
  'stop',
  'unsubscribe',
  'cancel',
  'end',
  'quit',
  'stop promotions',
  'opt out',
  'optout',
  'remove me',
]);

/** Words that opt a customer back in after they had stopped. */
const OPT_IN_KEYWORDS = new Set(['start', 'unstop', 'subscribe', 'resume', 'opt in', 'optin']);

/** `HH:MM` — the wall-clock format quiet hours are declared and compared in. */
const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * The organization's local wall-clock time right now, as minutes since midnight.
 *
 * `Intl.DateTimeFormat` is the timezone authority rather than an offset we store, because an offset
 * stored six months ago is wrong on the other side of a DST boundary — and being an hour wrong about
 * quiet hours means sending at 6am. An unknown zone makes this THROW, which is the intended
 * behaviour: a policy naming a zone the runtime cannot resolve is not a policy, and guessing UTC
 * would produce sends at genuinely arbitrary local times while looking configured.
 */
function localMinutesNow(timezone: string, now: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const hour = parts.find((p) => p.type === 'hour')?.value;
  const minute = parts.find((p) => p.type === 'minute')?.value;
  if (hour === undefined || minute === undefined) {
    throw new Error(`Could not read local time for timezone '${timezone}'`);
  }
  // 'en-GB' with hour12:false renders midnight as '24' in some ICU versions; normalize it.
  return (Number(hour) % 24) * 60 + Number(minute);
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

/**
 * Is `nowMinutes` inside the quiet window?
 *
 * The window normally WRAPS midnight (21:00 → 09:00), so the two cases are genuinely different
 * comparisons and not a stylistic choice. A start equal to the end is treated as an empty window
 * rather than a whole-day block — an org that sets both to 09:00 has said "no quiet hours", and
 * reading that as "never send" would silently disable their campaigns.
 */
function withinQuietHours(nowMinutes: number, startHhMm: string, endHhMm: string): boolean {
  const start = toMinutes(startHhMm);
  const end = toMinutes(endHhMm);
  if (start === end) return false;
  return start < end
    ? nowMinutes >= start && nowMinutes < end
    : nowMinutes >= start || nowMinutes < end;
}

/**
 * One referral rendered as evidence a human can act on, months later, without a code read.
 *
 * The message id leads because it is the part that can be verified independently — everything after
 * it is Meta's account of where the customer came from, and only the parts Meta actually sent are
 * included. A blank in a proof field is worse than a shorter proof: it reads as a value that was
 * lost rather than one that never existed.
 */
function describeReferral(providerMessageId: string, referral: InboundReferral): string {
  const parts: string[] = [];
  parts.push(`${referral.sourceType ?? 'referral'} entry point`);
  if (referral.sourceId !== null) parts.push(`id ${referral.sourceId}`);
  if (referral.headline !== null) parts.push(`"${referral.headline}"`);
  if (referral.sourceUrl !== null) parts.push(referral.sourceUrl);
  // Carried verbatim: this is the join key for Meta's Conversions API and it exists on this one
  // message only. Nothing reads it yet, which is exactly why it has to be stored now.
  if (referral.ctwaClid !== null) parts.push(`ctwa_clid ${referral.ctwaClid}`);
  return `${providerMessageId} — ${parts.join(', ')}`;
}

function assertHhMm(field: string, value: string): void {
  if (!HH_MM.test(value)) {
    throw new ValidationError('Validation failed', [
      { field, message: 'Must be a 24-hour local time in HH:MM form' },
    ]);
  }
}

/**
 * The gate every business-initiated message passes through, and the record of why it was allowed.
 *
 * Two rules shape everything here:
 *
 *   1. **Absence never permits.** No policy, no attestation, no consent record, an unreadable
 *      timezone — each of those REFUSES. There is no branch in this file that reaches a send because
 *      a lookup came back empty. The recipient is a member of the public who cannot appeal to us,
 *      and the cost of a wrong send falls on them and on the client's phone number, not on us.
 *   2. **Service and marketing are separate permissions.** A customer who asked a question has
 *      consented to being answered and to nothing else. `service` therefore checks only the
 *      suppression list; `marketing` checks policy, attestation, consent, suppression and the clock.
 */
class ConsentService {
  /**
   * Refuse unless this organization may message this contact for this purpose, right now.
   *
   * Throws rather than returning a boolean deliberately: a predicate can be called and its result
   * dropped, and the one call site that forgets to branch on it sends anyway. A throw cannot be
   * ignored by accident. Each refusal carries a distinct code so the inbox — and the conversational
   * layer — can tell the operator which of five different things is wrong.
   */
  async assertMaySend(params: {
    orgId: string;
    contactId: string;
    platform: CommercePlatform;
    externalId: string;
    purpose: ConsentPurpose;
    now?: Date;
  }): Promise<void> {
    const suppression = await consentRepository.isSuppressed(
      params.orgId,
      params.platform,
      params.externalId,
    );
    if (suppression !== null) {
      throw new ForbiddenError(
        `This contact is on your suppression list (${suppression.reason}) and cannot be messaged.`,
        'CONTACT_SUPPRESSED',
      );
    }

    // A service reply is answering someone who wrote first. It needs no marketing consent and no
    // quiet hours: replying at 3am to a question asked at 3am is the service working, not a
    // nuisance. The 24-hour window is enforced separately, by `commerceInboxService.sendReply`.
    if (params.purpose === 'service') return;

    const policy = await consentRepository.findPolicy(params.orgId);
    if (policy === null) {
      throw new ForbiddenError(
        'This organization has no messaging policy. Set quiet hours and attest to lawful opt-in ' +
          'before sending marketing messages.',
        'NO_MESSAGING_POLICY',
      );
    }
    if (policy.attestedAt === null) {
      throw new ForbiddenError(
        'Nobody has attested that this organization holds lawful opt-in for its contacts. ' +
          'Marketing messages cannot be sent until an owner or admin does.',
        'NOT_ATTESTED',
      );
    }

    const consent = await consentRepository.currentConsent(
      params.orgId,
      params.contactId,
      'marketing',
    );
    if (consent === null) {
      throw new ForbiddenError(
        'No marketing consent is on file for this contact.',
        'NO_MARKETING_CONSENT',
      );
    }
    if (consent.state === 'opted_out') {
      throw new ForbiddenError(
        'This contact has opted out of marketing messages.',
        'MARKETING_OPTED_OUT',
      );
    }

    const now = params.now ?? new Date();
    if (withinQuietHours(localMinutesNow(policy.timezone, now), policy.quietHoursStart, policy.quietHoursEnd)) {
      throw new ForbiddenError(
        `It is currently quiet hours for this organization (${policy.quietHoursStart}–` +
          `${policy.quietHoursEnd} ${policy.timezone}). Schedule this send for after they end.`,
        'QUIET_HOURS',
      );
    }
  }

  /**
   * Apply an inbound message's own words as a consent change, if it contained any.
   *
   * Called from the inbound path for every customer message, and does nothing for the overwhelming
   * majority of them. When it does fire it BOTH appends the consent row and writes the suppression,
   * because those answer different questions: the consent row is the evidence of what they said, and
   * the suppression is the thing every send actually checks. Recording only the first would leave a
   * perfectly documented opt-out that does not stop anything.
   *
   * Returns the consent row it wrote, or null when the message was not a keyword.
   */
  async applyInboundKeyword(params: {
    orgId: string;
    contactId: string;
    platform: CommercePlatform;
    externalId: string;
    body: string;
    providerMessageId: string;
  }): Promise<ContactConsent | null> {
    const normalized = params.body.trim().toLowerCase().replace(/\s+/g, ' ');
    const optOut = OPT_OUT_KEYWORDS.has(normalized);
    const optIn = OPT_IN_KEYWORDS.has(normalized);
    if (!optOut && !optIn) return null;

    const consent = await consentRepository.recordConsent({
      orgId: params.orgId,
      contactId: params.contactId,
      platform: params.platform,
      purpose: 'marketing',
      state: optOut ? 'opted_out' : 'opted_in',
      source: 'keyword',
      // The customer's own message id IS the evidence — the strongest kind there is, because it can
      // be re-read on the platform rather than taken on our word.
      evidence: params.providerMessageId,
      recordedByUserId: null,
    });

    if (optOut) {
      await consentRepository.suppress({
        orgId: params.orgId,
        platform: params.platform,
        externalId: params.externalId,
        reason: 'opt_out',
        detail: `Customer replied "${params.body.trim()}"`,
      });
    } else {
      await consentRepository.lift(params.orgId, params.platform, params.externalId);
    }

    logger.info('commerce: inbound consent keyword applied', {
      orgId: params.orgId,
      contactId: params.contactId,
      state: consent.state,
    });
    return consent;
  }

  /**
   * Record what a customer's ENTRY POINT says about their permission, if it says anything.
   *
   * Runs on the inbound path immediately after {@link applyInboundKeyword}, and covers the two ways a
   * message can carry its own provenance. They are genuinely different mechanisms and are weighed
   * differently:
   *
   *   **An opt-in link** puts a token in the prefilled text, and the customer sends the sentence
   *   attached to it from their own account. That is an affirmative act by the person themselves, in
   *   words we can show them again later, and Meta holds a copy. It is recorded at whatever purpose
   *   the link declares — including `marketing`, because "Yes, send me offers [3F9A…]" arriving from
   *   the number in question is exactly what marketing consent is supposed to look like. The source
   *   is `inbound_message`, since the message IS the evidence.
   *
   *   **A referral** means Meta says this conversation began at an ad or a post. That is weaker, and
   *   deliberately recorded as `service` no matter how the ad was worded: tapping "Message us" is
   *   agreeing to a conversation, not subscribing to a campaign, and an integration that quietly
   *   promoted ad clicks to marketing consent would build exactly the list the consent regime exists
   *   to prevent. It grants nothing the 24-hour service window would not already give; what it
   *   preserves is WHERE the contact came from, including the click id that exists on this one
   *   message and can never be recovered afterwards.
   *
   * Returns the consent row it wrote, or null when the message carried no entry point — which is the
   * outcome for nearly every message.
   */
  async applyEntryPoint(params: {
    orgId: string;
    contactId: string;
    platform: CommercePlatform;
    externalId: string;
    body: string;
    providerMessageId: string;
    referral: InboundReferral | null;
    /** True when the same message was an opt-out keyword. See below — it wins. */
    optedOutJustNow: boolean;
  }): Promise<ContactConsent | null> {
    // A message that said "STOP" is not also an opt-in, whatever link it arrived through. This can
    // happen for real: the phrase is fixed when the link is minted, and a customer who edits the
    // prefilled text down to "stop" before sending has been unambiguous about which half they meant.
    if (params.optedOutJustNow) return null;

    const token = findOptinToken(params.body);
    if (token !== null) {
      const link = await optinLinkRepository.findActiveByToken(token);
      // A token belonging to a DIFFERENT organization, in a message sent to this one. Meaningless at
      // best and forged at worst — someone who saw one business's sticker cannot consent on behalf of
      // another — so it is refused loudly rather than recorded against either party.
      if (link !== null && link.orgId !== params.orgId) {
        logger.warn('commerce: opt-in token belongs to another organization — ignoring', {
          orgId: params.orgId,
          providerMessageId: params.providerMessageId,
        });
        return null;
      }
      if (link !== null) {
        const consent = await consentRepository.recordConsent({
          orgId: params.orgId,
          contactId: params.contactId,
          platform: params.platform,
          purpose: link.purpose,
          state: 'opted_in',
          source: 'inbound_message',
          evidence: `${params.providerMessageId} — sent via opt-in link "${link.name}"`,
          recordedByUserId: null,
          optinLinkId: link.id,
        });

        // Someone who previously opted out and has now deliberately sent an opt-in sentence has
        // changed their mind, and the block has to lift or the consent is decorative. Only an
        // `opt_out` block, though: a `complaint` or a platform-level block is not this customer's to
        // undo by sending a phrase, and lifting one would put us back in front of somebody who
        // escalated to get away.
        if (link.purpose === 'marketing') {
          const suppression = await consentRepository.isSuppressed(
            params.orgId,
            params.platform,
            params.externalId,
          );
          if (suppression?.reason === 'opt_out') {
            await consentRepository.lift(params.orgId, params.platform, params.externalId);
          }
        }

        logger.info('commerce: opt-in recorded from a link', {
          orgId: params.orgId,
          contactId: params.contactId,
          linkId: link.id,
          purpose: link.purpose,
        });
        return consent;
      }
    }

    if (params.referral !== null) {
      return consentRepository.recordConsent({
        orgId: params.orgId,
        contactId: params.contactId,
        platform: params.platform,
        // `service`, always. See this method's docblock.
        purpose: 'service',
        state: 'opted_in',
        source: 'ad_click',
        evidence: describeReferral(params.providerMessageId, params.referral),
        recordedByUserId: null,
      });
    }

    return null;
  }

  /** Record consent a member gathered elsewhere — a form, an ad, an import, or their own attestation. */
  async recordConsent(params: {
    orgId: string;
    contactId: string;
    platform: CommercePlatform;
    purpose: ConsentPurpose;
    state: 'opted_in' | 'opted_out';
    source: ConsentSource;
    evidence: string;
    recordedByUserId: string;
  }): Promise<ContactConsent> {
    // Evidence is mandatory and cannot be whitespace. A consent row whose proof field is empty is
    // indistinguishable from an unchecked box, and it is the only column here that has to survive
    // being read back by someone who does not trust us.
    if (params.evidence.trim() === '') {
      throw new ValidationError('Validation failed', [
        {
          field: 'evidence',
          message: 'Say how this consent was obtained — a form URL, an ad id, or a list name',
        },
      ]);
    }

    const consent = await consentRepository.recordConsent({
      ...params,
      evidence: params.evidence.trim(),
    });

    // An opt-out recorded by a member must stop sends for the same reason a keyword opt-out does.
    if (params.state === 'opted_out' && params.purpose === 'marketing') {
      const { externalId } = await this.identityFor(params.orgId, params.contactId);
      await consentRepository.suppress({
        orgId: params.orgId,
        platform: params.platform,
        externalId,
        reason: 'opt_out',
        detail: consent.evidence,
      });
    }
    return consent;
  }

  async listConsentHistory(orgId: string, contactId: string): Promise<ContactConsent[]> {
    return consentRepository.listConsentHistory(orgId, contactId);
  }

  async listSuppressions(orgId: string, limit: number | undefined): Promise<Suppression[]> {
    const capped =
      limit === undefined
        ? MAX_SUPPRESSION_PAGE
        : Math.min(Math.max(Math.trunc(limit), 1), MAX_SUPPRESSION_PAGE);
    return consentRepository.listSuppressions(orgId, capped);
  }

  async suppress(params: {
    orgId: string;
    platform: CommercePlatform;
    externalId: string;
    reason: SuppressionReason;
    detail: string | null;
  }): Promise<Suppression> {
    return consentRepository.suppress(params);
  }

  /**
   * Lift a suppression. Deliberately does NOT record consent as a side effect — unblocking an
   * address and holding permission to market to it are separate facts, and an operator who lifts a
   * block to answer a support question has not thereby obtained an opt-in.
   */
  async lift(orgId: string, platform: CommercePlatform, externalId: string): Promise<void> {
    const lifted = await consentRepository.lift(orgId, platform, externalId);
    if (!lifted) {
      throw new NotFoundError('That address is not on the suppression list');
    }
  }

  async getPolicy(orgId: string): Promise<MessagingPolicy | null> {
    return consentRepository.findPolicy(orgId);
  }

  async setQuietHours(params: {
    orgId: string;
    timezone: string;
    quietHoursStart: string;
    quietHoursEnd: string;
  }): Promise<MessagingPolicy> {
    assertHhMm('quietHoursStart', params.quietHoursStart);
    assertHhMm('quietHoursEnd', params.quietHoursEnd);
    // Validate the zone at WRITE time, against the same resolver the gate will use at send time.
    // Storing an unresolvable zone would move the failure to the moment of a campaign send, where it
    // would read as "the send is broken" rather than "this setting was never valid".
    try {
      localMinutesNow(params.timezone, new Date());
    } catch {
      throw new ValidationError('Validation failed', [
        { field: 'timezone', message: `'${params.timezone}' is not a recognized IANA timezone` },
      ]);
    }
    return consentRepository.upsertQuietHours(params);
  }

  async attest(params: {
    orgId: string;
    attestedByUserId: string;
    attestationText: string;
  }): Promise<MessagingPolicy> {
    if (params.attestationText.trim() === '') {
      throw new ValidationError('Validation failed', [
        { field: 'attestationText', message: 'The attested statement cannot be empty' },
      ]);
    }
    const policy = await consentRepository.attest({
      ...params,
      attestationText: params.attestationText.trim(),
    });
    if (policy === null) {
      throw new ValidationError('Validation failed', [
        {
          field: 'orgId',
          message: 'Set quiet hours for this organization before attesting to lawful opt-in',
        },
      ]);
    }
    logger.info('commerce: lawful opt-in attested', {
      orgId: params.orgId,
      userId: params.attestedByUserId,
    });
    return policy;
  }

  /**
   * Which platform a contact was actually reached on.
   *
   * Read from the contact row rather than accepted from a request, deliberately: the platform is a
   * property of who this person is to the organization, and a caller allowed to assert it could
   * record consent against a surface the contact has never been messaged on — which would then
   * satisfy the send gate for a channel nobody agreed to.
   */
  async platformForContact(orgId: string, contactId: string): Promise<CommercePlatform> {
    return (await this.identityFor(orgId, contactId)).platform;
  }

  private async identityFor(
    orgId: string,
    contactId: string,
  ): Promise<{ platform: CommercePlatform; externalId: string }> {
    const identity = await consentRepository.findContactIdentity(orgId, contactId);
    if (identity === null) {
      throw new NotFoundError('Contact not found');
    }
    return identity;
  }
}

export const consentService = new ConsentService();
