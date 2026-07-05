import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type {
  ContactInviteAcceptedEvent,
  ContactInviteReceivedEvent,
  ContactWithUser,
} from '@stewra/shared-types';
import { SERVER_EVENTS } from '@stewra/shared-types';
import { api } from '../../services/api';
import { useSocket } from '../../hooks/useSocket';
import styles from './ContactNotifier.module.css';

interface Notice {
  readonly key: number;
  readonly text: string;
  readonly contact: ContactWithUser | null;
}

const VISIBLE_MS = 5000;

/**
 * Renders a transient top banner in response to contact socket events: "<name> invited you" and
 * "<name> accepted your invite — say hi". The accepted banner is clickable and opens a direct
 * conversation with the new contact. Mounted once, globally, so it shows on any route.
 */
export function ContactNotifier(): React.JSX.Element | null {
  const socket = useSocket();
  const navigate = useNavigate();
  const [notice, setNotice] = useState<Notice | null>(null);
  const keyRef = useRef(0);

  useEffect(() => {
    if (!socket) {
      return;
    }
    const show = (text: string, contact: ContactWithUser | null): void => {
      keyRef.current += 1;
      setNotice({ key: keyRef.current, text, contact });
    };
    const onReceived = (event: ContactInviteReceivedEvent): void => {
      show(`${event.invite.inviter.displayName} invited you to connect`, null);
    };
    const onAccepted = (event: ContactInviteAcceptedEvent): void => {
      show(`${event.contact.user.displayName} accepted your invite — say hi`, event.contact);
    };
    socket.on(SERVER_EVENTS.CONTACT_INVITE_RECEIVED, onReceived);
    socket.on(SERVER_EVENTS.CONTACT_INVITE_ACCEPTED, onAccepted);
    return () => {
      socket.off(SERVER_EVENTS.CONTACT_INVITE_RECEIVED, onReceived);
      socket.off(SERVER_EVENTS.CONTACT_INVITE_ACCEPTED, onAccepted);
    };
  }, [socket]);

  useEffect(() => {
    if (!notice) {
      return;
    }
    const timer = window.setTimeout(() => setNotice(null), VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  if (!notice) {
    return null;
  }

  const openConversation = async (): Promise<void> => {
    const contact = notice.contact;
    setNotice(null);
    if (!contact) {
      return;
    }
    const res = await api.createConversation({
      type: 'direct',
      participantUserIds: [contact.user.id],
    });
    navigate(`/chats/${res.conversation.id}`);
  };

  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={`${styles.banner} ${notice.contact ? styles.tappable : ''}`}
        onClick={() => void openConversation()}
        disabled={!notice.contact}
      >
        <span className={styles.text}>{notice.text}</span>
        {notice.contact ? <span className={styles.action}>Click to open chat</span> : null}
      </button>
    </div>
  );
}
