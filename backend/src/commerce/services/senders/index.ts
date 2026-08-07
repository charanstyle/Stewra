import type { CommercePlatform } from '@stewra/shared-types';
import type { CommerceSender, ResolvedChannelAccount } from './types.js';
import { buildWhatsappSender } from './whatsappCloudSender.js';
import { ValidationError } from '../../../utils/errors.js';

export type { CommerceSender, ResolvedChannelAccount } from './types.js';
export { buildWhatsappSender } from './whatsappCloudSender.js';

/**
 * Pick the sender for a platform, bound to one organization's credential.
 *
 * The same per-credential factory shape as `buildEmailSender(provider, credential)` — the platform
 * chooses the implementation, the account supplies the identity, and nothing is held between calls.
 *
 * Instagram and Messenger have no entry here and will not until their inbound adapters exist. That
 * is the honest state of things: Meta permits no business-initiated send on either, so a sender for
 * them would be a reply-only object that a campaign feature could pick up and quietly misuse.
 */
export function buildSender(account: ResolvedChannelAccount): CommerceSender {
  switch (account.platform) {
    case 'whatsapp_cloud':
      return buildWhatsappSender(account);
    case 'instagram':
    case 'messenger':
      throw new ValidationError('Validation failed', [
        {
          field: 'platform',
          message: `${account.platform} is inbox-only — Meta does not permit business-initiated sends on it.`,
        },
      ]);
    default:
      return assertNever(account.platform);
  }
}

/** Makes adding a platform to the union a compile error here until a sender decision is made for it. */
function assertNever(platform: never): never {
  throw new Error(`unhandled commerce platform: ${String(platform satisfies never)}`);
}

/** Re-exported so callers can name the union without importing shared-types for one type. */
export type { CommercePlatform };
