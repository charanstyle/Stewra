import { randomBytes } from 'node:crypto';
import type { ConsentPurpose, OptinLink } from '@stewra/shared-types';
import { optinLinkRepository } from '../repositories/optinLinkRepository.js';
import { channelAccountRepository } from '../repositories/channelAccountRepository.js';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

/**
 * Tokens are uppercase hex, which is a deliberate choice rather than the default one.
 *
 * A custom alphabet would buy more entropy per character, but hex is already free of every character
 * pair that gets misread off a printed sticker: there is no `O` to confuse with `0`, and no `I` or
 * `L` to confuse with `1`. A customer never types the token — it rides inside the prefilled message —
 * but an operator reads it back off a poster when they are working out which of four links a
 * complaint came from, and that is the moment the alphabet has to be unambiguous.
 *
 * Six bytes is 48 bits. This is not a secret in the sense a password is: knowing a token lets someone
 * send the same sentence any customer could have sent, and the resulting consent is recorded against
 * the phone number that sent it. It has to be unguessable enough that nobody stumbles onto another
 * organization's token by accident, and it comfortably is.
 */
const TOKEN_BYTES = 6;
const TOKEN_LENGTH = TOKEN_BYTES * 2;

/**
 * How the token appears inside the message: `... [3F9A2C7B41D0]`.
 *
 * Bracketed rather than bare so it reads as a reference number to the customer rather than as a typo,
 * and so the matcher has an anchor. Without delimiters, any twelve-character run inside an ordinary
 * sentence would have to be tested against the database, turning every inbound message into a query.
 */
const TOKEN_PATTERN = new RegExp(`\\[([0-9A-F]{${TOKEN_LENGTH}})\\]`);

const MAX_PHRASE_CHARS = 200;
const MAX_NAME_CHARS = 120;

/** `randomBytes` rather than `Math.random`: this value is the only thing standing between a stranger
 * and the ability to record opt-ins against another organization's link. */
function mintToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex').toUpperCase();
}

/**
 * Find this build's token inside a customer's message, if it carries one.
 *
 * Exported because the inbound path is the only consumer and it should not own the format. Returns
 * null for the overwhelming majority of messages, which is the expected outcome.
 */
export function findOptinToken(body: string): string | null {
  return TOKEN_PATTERN.exec(body.toUpperCase())?.[1] ?? null;
}

/**
 * Minting and retiring the links that collect consent from a customer's own words.
 *
 * Unlike its siblings there is no `META_COMMERCE_ENABLED` guard here, and it would be redundant
 * rather than merely absent: a link can only be minted against an ACTIVE `whatsapp_cloud` channel
 * account, and a channel account can only exist because somebody completed Embedded Signup, which
 * that flag gates. The stronger precondition is already enforced below.
 */
class OptinLinkService {
  async create(params: {
    orgId: string;
    createdByUserId: string;
    channelAccountId: string;
    name: string;
    purpose: ConsentPurpose;
    phrase: string;
  }): Promise<OptinLink> {
    const name = params.name.trim();
    if (name === '' || name.length > MAX_NAME_CHARS) {
      throw new ValidationError('Validation failed', [
        { field: 'name', message: `Give the link a name of 1–${MAX_NAME_CHARS} characters` },
      ]);
    }

    const phrase = params.phrase.trim();
    if (phrase === '' || phrase.length > MAX_PHRASE_CHARS) {
      throw new ValidationError('Validation failed', [
        {
          field: 'phrase',
          message:
            `Write the sentence the customer will send, up to ${MAX_PHRASE_CHARS} characters — ` +
            'it is the evidence of what they agreed to',
        },
      ]);
    }
    // The token is ours to add and its shape is load-bearing. A phrase that already contained a
    // bracketed run of the right shape would produce a message with two candidate tokens, and the
    // matcher would take whichever came first — which is how a customer could be made to opt in to a
    // link the business that printed the sticker never minted.
    if (findOptinToken(phrase) !== null) {
      throw new ValidationError('Validation failed', [
        { field: 'phrase', message: 'The sentence cannot contain a bracketed reference code' },
      ]);
    }

    const account = await channelAccountRepository.findForOrg(params.orgId, params.channelAccountId);
    if (account === null) {
      throw new NotFoundError('That channel is not connected to this organization');
    }
    if (account.platform !== 'whatsapp_cloud') {
      throw new ValidationError('Validation failed', [
        {
          field: 'channelAccountId',
          message: `Opt-in links open a WhatsApp chat; ${account.platform} has no such link.`,
        },
      ]);
    }
    if (account.status !== 'active') {
      throw new ValidationError('Validation failed', [
        {
          field: 'channelAccountId',
          message:
            `That channel is ${account.status}. Reconnect it before publishing a link that ` +
            'points at it.',
        },
      ]);
    }
    // Refused rather than guessed from `displayName`, which falls back to the WABA name and then to
    // its id. A link built out of a business name would open a chat with whatever number those
    // digits happened to spell, and it would be printed before anyone noticed.
    if (account.displayPhoneNumber === null) {
      throw new ValidationError('Validation failed', [
        {
          field: 'channelAccountId',
          message:
            'We do not have this number in a form a link can point at. Reconnect the channel to ' +
            'refresh it from Meta, then try again.',
        },
      ]);
    }

    const existing = await optinLinkRepository.findByName(params.orgId, name);
    if (existing !== null) {
      throw new ConflictError(
        `You already have an opt-in link called "${name}". Names are how a complaint is traced ` +
          'back to the thing the customer actually saw, so they have to be unique.',
      );
    }

    const token = mintToken();
    const link = await optinLinkRepository.create({
      orgId: params.orgId,
      channelAccountId: account.id,
      name,
      phoneE164: account.displayPhoneNumber,
      purpose: params.purpose,
      prefillText: `${phrase} [${token}]`,
      token,
      createdByUserId: params.createdByUserId,
    });

    logger.info('commerce: opt-in link minted', {
      orgId: params.orgId,
      linkId: link.id,
      purpose: link.purpose,
    });
    return link;
  }

  async listForOrg(orgId: string): Promise<OptinLink[]> {
    return optinLinkRepository.listForOrg(orgId);
  }

  /**
   * Retire a link. The consents it already gathered are untouched and stay attributed to it — they
   * were validly given, and erasing where they came from would destroy the only record that answers
   * a complaint about them.
   */
  async disable(orgId: string, linkId: string): Promise<OptinLink> {
    const link = await optinLinkRepository.disable(orgId, linkId);
    if (link === null) {
      throw new NotFoundError('Opt-in link not found');
    }
    return link;
  }
}

export const optinLinkService = new OptinLinkService();
