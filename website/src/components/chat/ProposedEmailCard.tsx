import type { ConfirmEmailAction, ProposedEmail } from '@stewra/shared-types';
import { MailIcon } from '../icons/Icons';
import styles from './ProposedEmailCard.module.css';

interface ProposedEmailCardProps {
  readonly proposal: ProposedEmail;
  /** Invoked when the user clicks Send or Cancel; the page performs the API round-trip. */
  readonly onConfirm: (action: ConfirmEmailAction) => void;
  /** True while a confirm request for this proposal is in flight (disables the buttons). */
  readonly busy: boolean;
}

/** A friendly line for each terminal (non-pending) proposal state. */
function terminalMessage(proposal: ProposedEmail): string {
  switch (proposal.status) {
    case 'sent':
      return `Sent to ${proposal.to}`;
    case 'cancelled':
      return 'Cancelled — not sent';
    case 'failed':
      return proposal.failureReason === 'no_send_account'
        ? 'Could not send — connect a Google account with send permission in Activity.'
        : 'Could not send right now. Please try again.';
    default:
      return '';
  }
}

/**
 * The in-chat confirmation card for an email Stewra drafted. While `pending` it shows the draft
 * (to/subject/body) with Send / Cancel; once resolved it collapses to a short status line. Purely
 * presentational — the page owns the API call and re-renders this from the updated message.
 *
 * This is the web twin of the mobile `ProposedEmailCard`, and the ONLY approve surface on web: Stewra
 * (the untrusted agent) can never send from here — clicking Send calls the authenticated, confirm-gated
 * POST /messages/:id/confirm-email, the same trusted executor the mobile card uses.
 */
export function ProposedEmailCard({
  proposal,
  onConfirm,
  busy,
}: ProposedEmailCardProps): React.JSX.Element {
  const pending = proposal.status === 'pending';
  const failed = proposal.status === 'failed';

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <MailIcon size={14} className={styles.headerIcon} />
        Draft email
      </div>

      <div className={styles.field}>
        <span className={styles.label}>To</span>
        <span className={styles.value}>{proposal.to}</span>
      </div>
      <div className={styles.field}>
        <span className={styles.label}>Subject</span>
        <span className={styles.value}>{proposal.subject}</span>
      </div>
      <p className={styles.body}>{proposal.body}</p>

      {pending ? (
        busy ? (
          <div className={styles.busyRow}>
            <span className={styles.spinner}>Sending…</span>
          </div>
        ) : (
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.cancel}
              disabled={busy}
              onClick={() => onConfirm('cancel')}
            >
              Cancel
            </button>
            <button
              type="button"
              className={styles.send}
              disabled={busy}
              onClick={() => onConfirm('send')}
            >
              Send
            </button>
          </div>
        )
      ) : (
        <p className={`${styles.status} ${failed ? styles.statusFailed : styles.statusDone}`}>
          {terminalMessage(proposal)}
        </p>
      )}
    </div>
  );
}
