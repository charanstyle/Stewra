import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ContactWithUser } from '@stewra/shared-types';
import { api } from '../services/api';
import { callService } from '../services/call/callService';
import { useAuth } from './AuthContext';

interface ContactsContextValue {
  readonly contacts: ReadonlyArray<ContactWithUser>;
  readonly loading: boolean;
  refresh: () => Promise<void>;
  /** Resolve a userId to a display name, falling back to the raw id when unknown. */
  displayNameFor: (userId: string) => string;
}

const ContactsContext = createContext<ContactsContextValue | null>(null);

export function ContactsProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { user } = useAuth();
  const [contacts, setContacts] = useState<ReadonlyArray<ContactWithUser>>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await api.listContacts();
      setContacts(res.contacts);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user) {
      void refresh();
    } else {
      setContacts([]);
    }
  }, [user, refresh]);

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
    (): ContactsContextValue => ({ contacts, loading, refresh, displayNameFor }),
    [contacts, loading, refresh, displayNameFor],
  );

  return <ContactsContext.Provider value={value}>{children}</ContactsContext.Provider>;
}

export function useContacts(): ContactsContextValue {
  const ctx = useContext(ContactsContext);
  if (ctx === null) {
    throw new Error('useContacts must be used within a ContactsProvider');
  }
  return ctx;
}
