import { useEffect, useState } from 'react';
import { CLIENT_EVENTS, SERVER_EVENTS } from '@stewra/shared-types';
import type { PresenceStatus, PresenceUpdateEvent, UUID } from '@stewra/shared-types';
import { useSocket } from './useSocket';

/** The live presence of one user: their status plus when they were last active (for "last seen"). */
export interface Presence {
  readonly status: PresenceStatus;
  readonly lastActiveAt: string;
}

/** A live map of `userId → presence` for the subscribed users. Absent = unknown (treat offline). */
export type PresenceMap = ReadonlyMap<UUID, Presence>;

/**
 * Subscribe to presence for a set of users (typically the caller's contacts or a conversation's other
 * participants) and keep a live map updated from the subscribe ack + `presence:update` broadcasts.
 * Each entry carries `lastActiveAt` so a header can render "last seen …". Re-subscribes when the set changes.
 */
export function usePresence(userIds: ReadonlyArray<UUID>): PresenceMap {
  const socket = useSocket();
  const [presence, setPresence] = useState<Map<UUID, Presence>>(new Map());
  // A stable key so the effect only re-runs when the actual set of ids changes, not on every render.
  const key = [...userIds].sort().join(',');

  useEffect(() => {
    if (!socket || userIds.length === 0) {
      return;
    }
    socket.emit(CLIENT_EVENTS.PRESENCE_SUBSCRIBE, { userIds: [...userIds] }, (res) => {
      if (res.ok) {
        setPresence((prev) => {
          const next = new Map(prev);
          for (const s of res.statuses) {
            next.set(s.userId, { status: s.status, lastActiveAt: s.lastActiveAt });
          }
          return next;
        });
      }
    });

    const onUpdate = (event: PresenceUpdateEvent): void => {
      setPresence((prev) => {
        const next = new Map(prev);
        next.set(event.userId, { status: event.status, lastActiveAt: event.lastActiveAt });
        return next;
      });
    };
    socket.on(SERVER_EVENTS.PRESENCE_UPDATE, onUpdate);
    return () => {
      socket.off(SERVER_EVENTS.PRESENCE_UPDATE, onUpdate);
    };
    // `key` captures the id-set identity; `userIds` is read fresh inside. eslint-disable-next-line
  }, [socket, key]);

  return presence;
}
