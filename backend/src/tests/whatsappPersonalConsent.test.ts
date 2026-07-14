import {
  WHATSAPP_PERSONAL_CONSENT_SENTENCE,
  isConsentSentenceValid,
  normalizeConsentSentence,
} from '@stewra/shared-types';

/**
 * The typed consent is the ONLY thing standing between a user and a permanently banned WhatsApp account,
 * so its comparison rules are pinned here rather than left to whatever the frontend happens to do.
 *
 * The shape of the contract: forgive what a human gets wrong without changing meaning; refuse anything
 * that means something else, or nothing at all. A checkbox would pass none of these tests, which is the
 * point — we deliberately cannot accept a click.
 */
describe('the WhatsApp-personal consent sentence', () => {
  it('accepts the sentence typed exactly', () => {
    expect(isConsentSentenceValid(WHATSAPP_PERSONAL_CONSENT_SENTENCE)).toBe(true);
  });

  it('forgives casing, padding, doubled spaces and a trailing full stop', () => {
    // Every one of these is a real person typing the right words, and none of them changes the meaning.
    expect(isConsentSentenceValid('  i understand my whatsapp account can be permanently banned  ')).toBe(true);
    expect(isConsentSentenceValid('I UNDERSTAND MY WHATSAPP ACCOUNT CAN BE PERMANENTLY BANNED')).toBe(true);
    expect(isConsentSentenceValid('I understand my  WhatsApp account can be permanently banned.')).toBe(true);
  });

  it('rejects an empty or throwaway answer', () => {
    for (const typed of ['', '   ', 'yes', 'ok', 'I agree', 'true']) {
      expect(isConsentSentenceValid(typed)).toBe(false);
    }
  });

  it('rejects a sentence that is close but says something different', () => {
    // Dropping "permanently", or "not", inverts or softens exactly the risk being acknowledged.
    expect(isConsentSentenceValid('I understand my WhatsApp account can be banned')).toBe(false);
    expect(isConsentSentenceValid('I understand my WhatsApp account cannot be permanently banned')).toBe(false);
    expect(isConsentSentenceValid('I understand my WhatsApp account can be permanently banned maybe')).toBe(false);
  });

  it('does not accept a mere prefix or a substring of the sentence', () => {
    expect(isConsentSentenceValid('I understand')).toBe(false);
    expect(isConsentSentenceValid('permanently banned')).toBe(false);
  });

  it('normalizes idempotently, so client and server can never disagree on a second pass', () => {
    const once = normalizeConsentSentence('  I Understand   My WhatsApp Account Can Be Permanently Banned. ');
    expect(normalizeConsentSentence(once)).toBe(once);
    expect(once).toBe(normalizeConsentSentence(WHATSAPP_PERSONAL_CONSENT_SENTENCE));
  });

  it('still names the actual consequence — a guard against the copy being quietly softened', () => {
    // If someone reworks this sentence into something vague, this fails and they must bump the version
    // deliberately rather than by accident. The words are the feature.
    expect(WHATSAPP_PERSONAL_CONSENT_SENTENCE.toLowerCase()).toContain('permanently banned');
  });
});
