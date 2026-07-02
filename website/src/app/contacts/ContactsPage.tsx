import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type {
  ContactInvite,
  ContactWithUser,
  PublicUser,
} from '@stewra/shared-types';
import { AppNav } from '../../components/AppNav/AppNav';
import { api, ApiError } from '../../services/api';
import styles from './ContactsPage.module.css';

function describeError(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong';
}

export default function ContactsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [contacts, setContacts] = useState<ReadonlyArray<ContactWithUser>>([]);
  const [received, setReceived] = useState<ReadonlyArray<ContactInvite>>([]);
  const [sent, setSent] = useState<ReadonlyArray<ContactInvite>>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [results, setResults] = useState<ReadonlyArray<PublicUser>>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [contactsRes, invitesRes] = await Promise.all([api.listContacts(), api.listInvites()]);
      setContacts(contactsRes.contacts);
      setReceived(invitesRes.received);
      setSent(invitesRes.sent);
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runSearch = useCallback(async (): Promise<void> => {
    setError(null);
    if (searchQuery.trim() === '') {
      setResults([]);
      return;
    }
    try {
      const res = await api.searchUsers(searchQuery.trim());
      setResults(res.users);
    } catch (err) {
      setError(describeError(err));
    }
  }, [searchQuery]);

  const invite = useCallback(
    async (email: string): Promise<void> => {
      setError(null);
      setNotice(null);
      try {
        await api.sendInvite({ inviteeEmail: email });
        setNotice(`Invite sent to ${email}.`);
        setInviteEmail('');
        await refresh();
      } catch (err) {
        setError(describeError(err));
      }
    },
    [refresh],
  );

  const respond = useCallback(
    async (inviteId: string, action: 'accept' | 'decline'): Promise<void> => {
      setError(null);
      try {
        await api.respondInvite(inviteId, { action });
        await refresh();
      } catch (err) {
        setError(describeError(err));
      }
    },
    [refresh],
  );

  const toggleBlock = useCallback(
    async (contactUserId: string, block: boolean): Promise<void> => {
      setError(null);
      try {
        await api.blockContact({ contactUserId, block });
        await refresh();
      } catch (err) {
        setError(describeError(err));
      }
    },
    [refresh],
  );

  const startChat = useCallback(
    async (userId: string): Promise<void> => {
      setError(null);
      try {
        const res = await api.createConversation({ type: 'direct', participantUserIds: [userId] });
        navigate(`/chats/${res.conversation.id}`);
      } catch (err) {
        setError(describeError(err));
      }
    },
    [navigate],
  );

  return (
    <div className={styles.page}>
      <AppNav />
      <main className={styles.main}>
        <h1 className={styles.title}>Contacts</h1>
        {error && <div className={styles.error}>{error}</div>}
        {notice && <div className={styles.notice}>{notice}</div>}

        <section className={styles.card}>
          <h2 className={styles.cardTitle}>Find people</h2>
          <div className={styles.row}>
            <input
              className={styles.input}
              value={searchQuery}
              placeholder="Search by name or email"
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  void runSearch();
                }
              }}
            />
            <button type="button" className={styles.primary} onClick={() => void runSearch()}>
              Search
            </button>
          </div>
          <ul className={styles.list}>
            {results.map((u) => (
              <li key={u.id} className={styles.listRow}>
                <span>
                  <strong>{u.displayName}</strong> <em className={styles.muted}>{u.email}</em>
                </span>
                <button type="button" className={styles.ghost} onClick={() => void startChat(u.id)}>
                  Message
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className={styles.card}>
          <h2 className={styles.cardTitle}>Invite by email</h2>
          <div className={styles.row}>
            <input
              className={styles.input}
              value={inviteEmail}
              placeholder="name@example.com"
              onChange={(e) => setInviteEmail(e.target.value)}
            />
            <button
              type="button"
              className={styles.primary}
              onClick={() => void invite(inviteEmail.trim())}
            >
              Send invite
            </button>
          </div>
        </section>

        {received.length > 0 && (
          <section className={styles.card}>
            <h2 className={styles.cardTitle}>Invites for you</h2>
            <ul className={styles.list}>
              {received.map((inv) => (
                <li key={inv.id} className={styles.listRow}>
                  <span>{inv.inviteeEmail}</span>
                  <span className={styles.actions}>
                    <button
                      type="button"
                      className={styles.primary}
                      onClick={() => void respond(inv.id, 'accept')}
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      className={styles.ghost}
                      onClick={() => void respond(inv.id, 'decline')}
                    >
                      Decline
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className={styles.card}>
          <h2 className={styles.cardTitle}>Your contacts</h2>
          {contacts.length === 0 && <p className={styles.muted}>No contacts yet.</p>}
          <ul className={styles.list}>
            {contacts.map((c) => {
              const blocked = c.contact.status === 'blocked';
              return (
                <li key={c.contact.id} className={styles.listRow}>
                  <span>
                    <strong>{c.user.displayName}</strong>{' '}
                    <em className={styles.muted}>{c.user.email}</em>
                    {blocked && <span className={styles.blockedTag}> · blocked</span>}
                  </span>
                  <span className={styles.actions}>
                    {!blocked && (
                      <button
                        type="button"
                        className={styles.ghost}
                        onClick={() => void startChat(c.user.id)}
                      >
                        Message
                      </button>
                    )}
                    <button
                      type="button"
                      className={styles.ghost}
                      onClick={() => void toggleBlock(c.user.id, !blocked)}
                    >
                      {blocked ? 'Unblock' : 'Block'}
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>

        {sent.length > 0 && (
          <section className={styles.card}>
            <h2 className={styles.cardTitle}>Invites you sent</h2>
            <ul className={styles.list}>
              {sent.map((inv) => (
                <li key={inv.id} className={styles.listRow}>
                  <span>{inv.inviteeEmail}</span>
                  <em className={styles.muted}>{inv.status}</em>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </div>
  );
}
