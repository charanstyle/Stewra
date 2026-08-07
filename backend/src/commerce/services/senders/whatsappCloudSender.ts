import { z } from 'zod';
import type { CommerceSender, ResolvedChannelAccount } from './types.js';
import { config } from '../../../config/unifiedConfig.js';
import { ServiceUnavailableError, ValidationError } from '../../../utils/errors.js';

/** Meta's hard cap on a text body. Longer is rejected outright rather than truncated by them. */
const MAX_BODY_CHARS = 4096;

/**
 * Meta ANSWERED, and the answer was no. The one failure whose outcome is certain: an error status
 * means no message was delivered, so the caller may safely record a failure and move on. Every other
 * error a send can throw — a timeout, a dropped connection, an unparseable 200 — leaves the outcome
 * unknown, and a broadcast must treat those differently: retrying an unknown outcome is how a
 * customer gets the same campaign message twice.
 */
export class WhatsappSendRefusedError extends Error {
  constructor(status: number, body: string) {
    super(`WhatsApp refused the send (${status}): ${body}`);
    this.name = 'WhatsappSendRefusedError';
  }
}

/**
 * The only part of Meta's send response we depend on. Parsed rather than asserted: this is a remote
 * service's output, and an assertion would let a shape change become a confident `undefined` several
 * frames away from the call that caused it.
 */
const graphMessageResponseSchema = z.object({
  messages: z.array(z.object({ id: z.string().min(1) })).min(1),
});

/**
 * Build a sender bound to ONE organization's WhatsApp account.
 *
 * A factory, not a singleton — this is the whole difference between the commerce plane and the
 * personal-assistant channel. `services/channelSenders/whatsappCloudSender.ts` reads
 * `config.whatsapp.phoneNumberId` and `.accessToken` at module scope, which is correct there
 * (Stewra has exactly one business number) and fatal here: a self-serve SaaS has one credential per
 * client, and a module-scope read would send every tenant's messages from whichever number happened
 * to be in the environment.
 *
 * The token lives in the closure for the lifetime of one send and is never written anywhere. Build a
 * new sender per operation rather than caching one — a cached sender outlives a revocation.
 */
export function buildWhatsappSender(account: ResolvedChannelAccount): CommerceSender {
  if (!config.metaCommerce.enabled) {
    // Not a degraded mode: without the commerce Meta app there is no Graph version to call and no
    // app secret to verify the delivery webhook with. Refusing is the only honest answer.
    throw new ServiceUnavailableError('The commerce WhatsApp channel is not configured.');
  }
  const { graphBaseUrl, graphVersion } = config.metaCommerce;

  const phoneNumberId = account.phoneNumberId;
  if (phoneNumberId === null || phoneNumberId.length === 0) {
    // A WhatsApp account with no phone number id cannot send at all. Failing here names the account;
    // letting it through would produce a 404 from Graph against a URL with an empty path segment.
    throw new ValidationError('Validation failed', [
      {
        field: 'phoneNumberId',
        message: `Channel account ${account.id} has no WhatsApp phone number id; reconnect it.`,
      },
    ]);
  }

  const endpoint = `${graphBaseUrl}/${graphVersion}/${phoneNumberId}/messages`;

  async function post(payload: unknown): Promise<string> {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${account.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    // Meta returns a structured error body. It is surfaced verbatim because "the message never
    // arrived and nothing failed on our side" is otherwise completely invisible.
    const text = await response.text();
    if (!response.ok) {
      throw new WhatsappSendRefusedError(response.status, text);
    }

    const parsed = graphMessageResponseSchema.safeParse(JSON.parse(text));
    const messageId = parsed.success ? parsed.data.messages[0]?.id : undefined;
    if (messageId === undefined) {
      // A 200 whose body carries no message id leaves nothing to reconcile against the delivery
      // webhook. Inventing an id here would make a lost message look delivered.
      throw new Error(`WhatsApp accepted the send but returned no message id: ${text}`);
    }
    return messageId;
  }

  return {
    platform: 'whatsapp_cloud',

    async sendText(to: string, body: string): Promise<string> {
      const trimmed = body.trim();
      if (trimmed.length === 0 || trimmed.length > MAX_BODY_CHARS) {
        // Not split into parts, unlike the assistant channel: a business reply that arrives as three
        // messages reads as three notifications to a customer. The caller decides how to shorten it.
        throw new ValidationError('Validation failed', [
          {
            field: 'body',
            message: `Message must be between 1 and ${MAX_BODY_CHARS} characters.`,
          },
        ]);
      }
      return post({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { preview_url: false, body: trimmed },
      });
    },

    async sendTemplate(params): Promise<string> {
      const variables = params.variables ?? [];
      return post({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: params.to,
        type: 'template',
        template: {
          name: params.templateName,
          language: { code: params.languageCode },
          // Meta rejects an empty `components` array, so it is present only when there is something
          // to fill in — a template with no placeholders takes no body component at all.
          ...(variables.length > 0
            ? {
                components: [
                  {
                    type: 'body',
                    parameters: variables.map((text) => ({ type: 'text', text })),
                  },
                ],
              }
            : {}),
        },
      });
    },
  };
}
