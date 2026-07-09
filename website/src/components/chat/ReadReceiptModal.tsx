import { useEffect, useState } from 'react';
import type { Message, PublicUser, ReadReceipt } from '@stewra/shared-types';
import { api } from '../../services/api';
import { Avatar } from '../Avatar/Avatar';
import styles from './ReadReceiptModal.module.css';

interface ReadReceiptModalProps {
  /** The message whose receipts to show (must be one the caller authored). */
  readonly message: Message;
  /** The conversation's other participants, for naming/photographing each reader. */
  readonly participants: ReadonlyArray<PublicUser>;
  readonly onClose: () => void;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Per-person Delivered/Read detail for one outgoing message. Fetches the authoritative receipt list on
 * open (the live `readReceipts` on the message is enough to render immediately, but a refetch reconciles
 * anything missed). A plain overlay — the project ships no dialog dependency.
 */
export function ReadReceiptModal({
  message,
  participants,
  onClose,
}: ReadReceiptModalProps): React.JSX.Element {
  const [receipts, setReceipts] = useState<ReadonlyArray<ReadReceipt>>(message.readReceipts);

  useEffect(() => {
    let active = true;
    api
      .listMessageReceipts(message.id)
      .then((res) => {
        if (active) setReceipts(res.receipts);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [message.id]);

  const readByUserId = new Map(receipts.map((r) => [r.userId, r]));
  const delivered = message.deliveredAt;

  return (
    <div className={styles.backdrop} onClick={onClose} role="presentation">
      <div className={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className={styles.header}>
          <span className={styles.title}>Message info</span>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <ul className={styles.list}>
          {participants.map((p) => {
            const receipt = readByUserId.get(p.id);
            return (
              <li key={p.id} className={styles.row}>
                <Avatar name={p.displayName} avatarUrl={p.avatarUrl} size={32} />
                <div className={styles.who}>
                  <span className={styles.name}>{p.displayName}</span>
                  <span className={styles.state}>
                    {receipt
                      ? `Read ${formatTime(receipt.readAt)}`
                      : delivered
                        ? `Delivered ${formatTime(delivered)}`
                        : 'Sent'}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

export default ReadReceiptModal;
