import type { ConfirmCommerceReplyAction, ProposedCommerceReply } from '@stewra/shared-types';
import { ChatBubbleIcon } from '../icons/Icons';
import styles from './ProposedCommerceReplyCard.module.css';

interface ProposedCommerceReplyCardProps {
  readonly proposal: ProposedCommerceReply;
  /** Invoked when the user clicks Send or Cancel; the page performs the API round-trip. */
  readonly onConfirm: (action: ConfirmCommerceReplyAction) => void;
  /** True while a confirm request for this proposal is in flight (disables the buttons). */
  readonly busy: boolean;
}

/** A friendly line for each terminal (non-pending) proposal state. */
function terminalMessage(proposal: ProposedCommerceReply): string {
  switch (proposal.status) {
    case 'sent':
      return `Sent to ${proposal.contactName}`;
    case 'cancelled':
      return 'Cancelled — not sent';
    case 'failed':
      return proposal.failureReason
        ? `Could not send — ${proposal.failureReason}`
        : 'Could not send right now. Please try again.';
    default:
      return '';
  }
}

/**
 * The in-chat confirmation card for a reply Stewra proposed to one of an organization's CUSTOMERS.
 *
 * The recipient is the reason this card exists and the reason it shows the whole message body rather
 * than a summary: they are a member of the public who never spoke to Stewra, the message will arrive
 * under the business's name, and a delivered WhatsApp message cannot be recalled. So the user reads
 * exactly what will be sent, to exactly whom, from exactly which business, before anything happens.
 *
 * Purely presentational — the page owns the API call and re-renders this from the updated message.
 * The web twin of the mobile card, and one of two approve surfaces (the other being a
 * natural-language "yes" in chat): Stewra can never send this itself. Clicking Send calls the
 * authenticated POST /messages/:id/confirm-commerce-reply, which runs the SAME executor the "yes"
 * path does.
 */
export function ProposedCommerceReplyCard({
  proposal,
  onConfirm,
  busy,
}: ProposedCommerceReplyCardProps): React.JSX.Element {
  // A `failed` send is usually transient (a network blip, a token that needs refreshing), so it stays
  // actionable rather than forcing the user to retype the reply. Only `sent`/`cancelled` collapse to a
  // status line — `sent` because the customer already has it and there is no undo.
  const failed = proposal.status === 'failed';
  const actionable = proposal.status === 'pending' || failed;

  return (
    <div className={styles.card} data-testid="commerce-reply-card" data-status={proposal.status}>
      <div className={styles.header}>
        <ChatBubbleIcon size={14} className={styles.headerIcon} />
        Reply to customer
      </div>

      <div className={styles.field}>
        <span className={styles.label}>To</span>
        <span className={styles.value}>{proposal.contactName}</span>
      </div>
      <div className={styles.field}>
        <span className={styles.label}>From</span>
        <span className={styles.value}>{proposal.orgName}</span>
      </div>
      <p className={styles.body}>{proposal.body}</p>

      {/* When a send failed, show why above the buttons — then let the user retry or dismiss. */}
      {failed && (
        <p className={`${styles.status} ${styles.statusFailed}`}>{terminalMessage(proposal)}</p>
      )}

      {actionable ? (
        busy ? (
          <div className={styles.busyRow}>
            <span className={styles.spinner} data-testid="commerce-reply-busy">
              Sending…
            </span>
          </div>
        ) : (
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.cancel}
              disabled={busy}
              onClick={() => onConfirm('cancel')}
              data-testid="commerce-reply-cancel"
            >
              {failed ? 'Dismiss' : 'Cancel'}
            </button>
            <button
              type="button"
              className={styles.send}
              disabled={busy}
              onClick={() => onConfirm('send')}
              data-testid="commerce-reply-send"
            >
              {failed ? 'Try again' : 'Send'}
            </button>
          </div>
        )
      ) : (
        <p className={`${styles.status} ${styles.statusDone}`} data-testid="commerce-reply-status">
          {terminalMessage(proposal)}
        </p>
      )}
    </div>
  );
}
