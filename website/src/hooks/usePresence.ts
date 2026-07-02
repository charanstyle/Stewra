import { useEffect, useState } from 'react';
import { CLIENT_EVENTS, SERVER_EVENTS } from '@stewra/shared-types';
import type { PresenceStatus, UUID } from '@stewra/shared-types';
import { useSocket } from './useSocket';

/** A live map of `userId → presence status` for the subscribed users. Absent = unknown (treat offline). */
export type PresenceMap = ReadonlyMap<UUID, PresenceStatus>;

/**
 * Subscribe to presence for a set of users (typically the caller's contacts) and keep a live status
 * map updated from `presence:update` broadcasts. Re-subscribes whenever the id set changes.
 */
export function usePresence(userIds: ReadonlyArray<UUID>): PresenceMap {
  const socket = useSocket();
  const [presence, setPresence] = useState<Map<UUID, PresenceStatus>>(new Map());
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
            next.set(s.userId, s.status);
          }
          return next;
        });
      }
    });

    const onUpdate = (event: { userId: UUID; status: PresenceStatus }): void => {
      setPresence((prev) => {
        const next = new Map(prev);
        next.set(event.userId, event.status);
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
