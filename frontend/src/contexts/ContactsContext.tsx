import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ContactInviteAcceptedEvent,
  ContactInviteReceivedEvent,
  ContactWithUser,
} from '@stewra/shared-types';
import { SERVER_EVENTS } from '@stewra/shared-types';
import { api } from '../services/api';
import { callService } from '../services/call/callService';
import { ensureSocketConnected, getSocket } from '../services/socket';
import { useAuth } from './AuthContext';
import { ContactNoticeBanner } from '../components/ContactNoticeBanner';

/** A transient, tappable in-app banner surfaced by a contact socket event. */
export interface ContactNotice {
  /** Bumps every time so a repeated identical message still re-triggers the banner animation. */
  readonly key: number;
  readonly text: string;
  /** When set, the banner is tappable and opens a direct conversation with this contact. */
  readonly contact: ContactWithUser | null;
}

interface ContactsContextValue {
  readonly contacts: ReadonlyArray<ContactWithUser>;
  readonly loading: boolean;
  refresh: () => Promise<void>;
  /** Resolve a userId to a display name, falling back to the raw id when unknown. */
  displayNameFor: (userId: string) => string;
  /**
   * Increments whenever a new invite arrives over the socket, so screens showing the pending-invite
   * list can re-fetch it live without their own socket subscription.
   */
  readonly invitesRevision: number;
}

const ContactsContext = createContext<ContactsContextValue | null>(null);

export function ContactsProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { user } = useAuth();
  const [contacts, setContacts] = useState<ReadonlyArray<ContactWithUser>>([]);
  const [loading, setLoading] = useState(false);
  const [invitesRevision, setInvitesRevision] = useState(0);
  const [notice, setNotice] = useState<ContactNotice | null>(null);
  const noticeKey = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await api.listContacts();
      setContacts(res.contacts);
    } finally {
      setLoading(false);
    }
  }, []);

  const showNotice = useCallback((text: string, contact: ContactWithUser | null): void => {
    noticeKey.current += 1;
    setNotice({ key: noticeKey.current, text, contact });
  }, []);

  useEffect(() => {
    if (user) {
      void refresh();
    } else {
      setContacts([]);
    }
  }, [user, refresh]);

  // Subscribe to contact notifications on the shared socket while authenticated. Received invites bump
  // `invitesRevision` (so the Contacts screen re-fetches its pending list) and flash a banner; accepted
  // invites add the new contact to the cache and flash a tappable "say hi" banner.
  useEffect(() => {
    if (!user) {
      return;
    }
    let cancelled = false;

    const onReceived = (event: ContactInviteReceivedEvent): void => {
      setInvitesRevision((n) => n + 1);
      showNotice(`${event.invite.inviter.displayName} invited you to connect`, null);
    };
    const onAccepted = (event: ContactInviteAcceptedEvent): void => {
      void refresh();
      showNotice(`${event.contact.user.displayName} accepted your invite — say hi`, event.contact);
    };

    void ensureSocketConnected().then(() => {
      if (cancelled) {
        return;
      }
      const socket = getSocket();
      socket?.on(SERVER_EVENTS.CONTACT_INVITE_RECEIVED, onReceived);
      socket?.on(SERVER_EVENTS.CONTACT_INVITE_ACCEPTED, onAccepted);
    });

    return () => {
      cancelled = true;
      const socket = getSocket();
      socket?.off(SERVER_EVENTS.CONTACT_INVITE_RECEIVED, onReceived);
      socket?.off(SERVER_EVENTS.CONTACT_INVITE_ACCEPTED, onAccepted);
    };
  }, [user, refresh, showNotice]);

  const displayNameFor = useCallback(
    (userId: string): string => {
      const match = contacts.find((entry) => entry.user.id === userId);
      return match ? match.user.displayName : userId;
    },
    [contacts],
  );

  // Keep callService's incoming-call peer resolver in sync with the contacts
  // cache so an incoming CALL_INCOMING (which only carries `fromUserId`) can
  // render the caller's name.
  useEffect(() => {
    callService.setPeerResolver(displayNameFor);
  }, [displayNameFor]);

  const value = useMemo(
    (): ContactsContextValue => ({ contacts, loading, refresh, displayNameFor, invitesRevision }),
    [contacts, loading, refresh, displayNameFor, invitesRevision],
  );

  return (
    <ContactsContext.Provider value={value}>
      {children}
      <ContactNoticeBanner notice={notice} onDismiss={() => setNotice(null)} />
    </ContactsContext.Provider>
  );
}

export function useContacts(): ContactsContextValue {
  const ctx = useContext(ContactsContext);
  if (ctx === null) {
    throw new Error('useContacts must be used within a ContactsProvider');
  }
  return ctx;
}
