import type { MessagingChannel } from '@stewra/shared-types';
import type { ChannelSender } from './types.js';
import { WHATSAPP_CHANNEL, whatsappCloudSender } from './whatsappCloudSender.js';

export type { ChannelSender } from './types.js';
export { WHATSAPP_CHANNEL, splitForWhatsapp } from './whatsappCloudSender.js';

/**
 * The registry of channels Stewra's SERVER can send on — the single place a new server-side messaging
 * surface plugs in (Telegram, SMS, …). Mirrors `emailSenders/index.ts`: the turn pipeline is
 * channel-agnostic, so adding a channel means adding an adapter here, not touching the agent.
 *
 * `whatsapp_personal` is deliberately ABSENT, and must stay absent. A companion-device client that logs
 * into a *user's own* WhatsApp account runs in the Stewra Bridge app on the user's own machine, never
 * here — build-plan principle 7. The server has no socket to that account and holds no credential for
 * it; it hands the reply to the bridge over the `/bridge` namespace and the bridge does the sending.
 * `channelSender('whatsapp_personal')` returning null is therefore the correct answer, not a gap.
 */
const REGISTRY: ReadonlyMap<MessagingChannel, ChannelSender> = new Map<MessagingChannel, ChannelSender>(
  [[WHATSAPP_CHANNEL, whatsappCloudSender]],
);

/** The server-side sender for `channel`, or null when the server does not send on it (see above). */
export function channelSender(channel: MessagingChannel): ChannelSender | null {
  return REGISTRY.get(channel) ?? null;
}
