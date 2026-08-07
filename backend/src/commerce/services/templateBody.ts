import type { TemplateCategory, TemplateStatus } from '@stewra/shared-types';
import { ValidationError } from '../../utils/errors.js';

/**
 * The rules a template body has to satisfy, and the translation of Meta's vocabulary into ours.
 *
 * Separate from the service because both halves are pure and both are worth testing directly: the
 * cost of getting either wrong is paid one recipient at a time, in the middle of a campaign, and a
 * test that has to stand up a Graph server to check "does a gap in the numbering get caught" is a
 * test nobody writes.
 */

/** Meta's cap on a template body. Longer is rejected at submission, not truncated. */
const MAX_BODY_CHARS = 1024;
/** Meta's cap on header and footer text. */
const MAX_HEADER_CHARS = 60;
const MAX_FOOTER_CHARS = 60;
/** Meta's name rule: lowercase letters, digits and underscores. */
const NAME_PATTERN = /^[a-z0-9_]{1,512}$/;
/** Positional placeholders. Meta supports named ones too; this build submits positional only. */
const PLACEHOLDER = /\{\{\s*(\d+)\s*\}\}/g;

/**
 * How many `{{n}}` the body carries, having first checked they are numbered the way Meta requires.
 *
 * Meta's rules, all of which it enforces at SUBMISSION — so failing them here costs a client one
 * clear message instead of a round trip and a Graph error code:
 *
 *  - numbered from 1 with no gaps and no repeats;
 *  - the body may not begin or end with a placeholder;
 *  - two placeholders may not sit next to each other with nothing but whitespace between them.
 *
 * The last two exist because a body that is mostly variable is indistinguishable from a template
 * being used to send arbitrary free text outside the service window, which is the thing template
 * approval exists to prevent.
 */
export function countTemplateVariables(bodyText: string): number {
  const trimmed = bodyText.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_BODY_CHARS) {
    throw new ValidationError('Validation failed', [
      { field: 'bodyText', message: `Body must be between 1 and ${MAX_BODY_CHARS} characters.` },
    ]);
  }

  const matches = [...trimmed.matchAll(PLACEHOLDER)];
  if (matches.length === 0) return 0;

  const numbers = matches.map((m) => Number(m[1]));
  for (let i = 0; i < numbers.length; i += 1) {
    if (numbers[i] !== i + 1) {
      throw new ValidationError('Validation failed', [
        {
          field: 'bodyText',
          message:
            'Placeholders must be numbered {{1}}, {{2}}, {{3}} … in order, with no gaps and no repeats. ' +
            `Found ${matches.map((m) => m[0]).join(' ')}.`,
        },
      ]);
    }
  }

  const first = matches[0];
  const last = matches[matches.length - 1];
  if (first !== undefined && first.index === 0) {
    throw new ValidationError('Validation failed', [
      { field: 'bodyText', message: 'The body cannot start with a placeholder — Meta rejects it.' },
    ]);
  }
  if (last !== undefined && last.index + last[0].length === trimmed.length) {
    throw new ValidationError('Validation failed', [
      { field: 'bodyText', message: 'The body cannot end with a placeholder — Meta rejects it.' },
    ]);
  }

  for (let i = 1; i < matches.length; i += 1) {
    const previous = matches[i - 1];
    const current = matches[i];
    if (previous === undefined || current === undefined) continue;
    const between = trimmed.slice(previous.index + previous[0].length, current.index);
    if (between.trim().length === 0) {
      throw new ValidationError('Validation failed', [
        {
          field: 'bodyText',
          message: `Placeholders ${previous[0]} and ${current[0]} need real text between them — Meta rejects adjacent ones.`,
        },
      ]);
    }
  }

  return matches.length;
}

/** Meta's name rule, checked before submission so the client gets the rule rather than a code. */
export function assertTemplateName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new ValidationError('Validation failed', [
      {
        field: 'name',
        message: 'Name must be lowercase letters, digits and underscores only (no spaces).',
      },
    ]);
  }
}

/**
 * Header and footer are plain text here, deliberately.
 *
 * Meta permits one placeholder in a text header, and permits none in a footer. Allowing header
 * variables would make {@link countTemplateVariables} an incomplete answer to "how many values does
 * this template need", and a broadcast checked against a body-only count would then be short by one
 * — the exact per-recipient, mid-campaign rejection this whole path exists to prevent. Media headers
 * and buttons are not modelled at all yet; a client who needs them builds the template in WhatsApp
 * Manager and the sync picks it up.
 */
export function assertHeaderAndFooter(headerText: string | null, footerText: string | null): void {
  if (headerText !== null && headerText.length > 0) {
    if (headerText.length > MAX_HEADER_CHARS) {
      throw new ValidationError('Validation failed', [
        { field: 'headerText', message: `Header must be ${MAX_HEADER_CHARS} characters or fewer.` },
      ]);
    }
    if (PLACEHOLDER.test(headerText)) {
      // `PLACEHOLDER` is a global regex, so `test` advances `lastIndex`. Reset it, or the next call
      // resumes mid-string and silently reports no placeholder in a header that has one.
      PLACEHOLDER.lastIndex = 0;
      throw new ValidationError('Validation failed', [
        {
          field: 'headerText',
          message: 'Headers cannot contain placeholders here. Put the variable text in the body.',
        },
      ]);
    }
    PLACEHOLDER.lastIndex = 0;
  }
  if (footerText !== null && footerText.length > MAX_FOOTER_CHARS) {
    throw new ValidationError('Validation failed', [
      { field: 'footerText', message: `Footer must be ${MAX_FOOTER_CHARS} characters or fewer.` },
    ]);
  }
}

/**
 * Meta's status word → ours. Anything unrecognized becomes `unknown`, which is not `approved`.
 *
 * The values here are the ones Meta documents today. It has added to this list before — `IN_APPEAL`,
 * `PENDING_DELETION` and `LIMIT_EXCEEDED` all arrived after the API shipped — which is precisely why
 * the default is `unknown` rather than the nearest neighbour. A template whose status this build has
 * never heard of is one nobody has decided is safe to send.
 */
export function mapTemplateStatus(providerStatus: string): TemplateStatus {
  switch (providerStatus.toUpperCase()) {
    case 'APPROVED':
      return 'approved';
    case 'PENDING':
    case 'IN_APPEAL':
      return 'pending';
    case 'REJECTED':
      return 'rejected';
    case 'PAUSED':
      return 'paused';
    case 'DISABLED':
    case 'DELETED':
    case 'PENDING_DELETION':
      return 'disabled';
    default:
      return 'unknown';
  }
}

/**
 * Meta's category word → ours, or null for a word this build has not met.
 *
 * Null here is different from `unknown` in {@link mapTemplateStatus}, deliberately. An unrecognized
 * STATUS becomes a refusal to send, which is safe. An invented CATEGORY would become a rate in a
 * cost forecast and a line on an invoice — so the honest answer is "no category", with Meta's
 * verbatim word preserved in `providerCategory` for whoever adds the mapping.
 */
export function mapTemplateCategory(providerCategory: string): TemplateCategory | null {
  switch (providerCategory.toUpperCase()) {
    case 'MARKETING':
      return 'marketing';
    case 'UTILITY':
      return 'utility';
    case 'AUTHENTICATION':
      return 'authentication';
    default:
      return null;
  }
}
