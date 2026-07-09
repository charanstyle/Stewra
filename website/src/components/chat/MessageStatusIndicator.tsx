import clsx from 'clsx';
import type { MessageStatus } from '@stewra/shared-types';
import { CheckIcon, CheckCheckIcon, ClockIcon } from '../icons/Icons';
import styles from './MessageStatusIndicator.module.css';

interface MessageStatusIndicatorProps {
  readonly status: MessageStatus;
  readonly size?: number;
}

/**
 * The WhatsApp-style delivery glyph shown on the caller's OWN outgoing bubbles:
 *   sending → clock · sent → one tick · delivered → two grey ticks · read → two accent ticks ·
 *   failed → a red "!". Incoming bubbles render no indicator (the caller passes their own messages only).
 */
export function MessageStatusIndicator({
  status,
  size = 14,
}: MessageStatusIndicatorProps): React.JSX.Element | null {
  switch (status) {
    case 'sending':
      return (
        <span className={clsx(styles.indicator, styles.muted)} title="Sending">
          <ClockIcon size={size} />
        </span>
      );
    case 'sent':
      return (
        <span className={clsx(styles.indicator, styles.muted)} title="Sent">
          <CheckIcon size={size} />
        </span>
      );
    case 'delivered':
      return (
        <span className={clsx(styles.indicator, styles.muted)} title="Delivered">
          <CheckCheckIcon size={size} />
        </span>
      );
    case 'read':
      return (
        <span className={clsx(styles.indicator, styles.read)} title="Read">
          <CheckCheckIcon size={size} />
        </span>
      );
    case 'failed':
      return (
        <span className={clsx(styles.indicator, styles.failed)} title="Failed to send">
          !
        </span>
      );
    default:
      return null;
  }
}

export default MessageStatusIndicator;
