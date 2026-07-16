import { z } from 'zod';
import { CLIENT_EVENTS } from '@stewra/shared-types';
import type { PresenceUpdateEvent } from '@stewra/shared-types';
import { presenceService } from '../services/presenceService.js';
import { BaseSocketHandler } from './baseSocketHandler.js';
import { presenceRoom } from './types.js';

const PresenceSubscribeSchema = z.object({
  userIds: z.array(z.string().uuid()).max(500),
});

/**
 * Presence subscribe handler. A client sends the ids it wants to watch (typically its contacts); the
 * socket joins each `presence_{userId}` room so it receives that user's future `presence:update`
 * broadcasts, and the current status of all requested users is returned via the ack callback for an
 * immediate paint. The online/offline TRANSITIONS themselves are emitted from `initSockets` (which owns
 * the connect/disconnect lifecycle), not here.
 */
export class PresenceHandler extends BaseSocketHandler {
  register(): void {
    this.on(
      CLIENT_EVENTS.PRESENCE_SUBSCRIBE,
      PresenceSubscribeSchema,
      async (payload, ack) => {
        await Promise.all(payload.userIds.map((id) => this.socket.join(presenceRoom(id))));
        const statuses = await presenceService.statuses(payload.userIds);
        const now = new Date().toISOString();
        const events: PresenceUpdateEvent[] = statuses.map((s) => ({
          userId: s.userId,
          status: s.status,
          lastActiveAt: s.lastSeen ?? now,
        }));
        if (typeof ack === 'function') ack({ ok: true, statuses: events });
      },
    );
  }
}
