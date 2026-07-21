import type {
  ConfirmRunnerSessionAction,
  ProposedRunnerSession,
  RunnerHarnessId,
} from '@stewra/shared-types';
import { LaptopIcon } from '../icons/Icons';
import styles from './ProposedRunnerSessionCard.module.css';

interface ProposedRunnerSessionCardProps {
  readonly proposal: ProposedRunnerSession;
  /** Invoked when the user clicks Start or Cancel; the page performs the API round-trip. */
  readonly onConfirm: (action: ConfirmRunnerSessionAction) => void;
  /** True while a confirm request for this proposal is in flight (disables the buttons). */
  readonly busy: boolean;
}

/** Human labels for the harness ids. */
const HARNESS_LABELS: Record<RunnerHarnessId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'gemini-cli': 'Gemini CLI',
};

/** A friendly line for each terminal (non-pending) proposal state. */
function terminalMessage(proposal: ProposedRunnerSession): string {
  switch (proposal.status) {
    case 'sent':
      return `Started on ${proposal.deviceName}`;
    case 'cancelled':
      return 'Cancelled — not started';
    case 'failed':
      return proposal.failureReason
        ? `Could not start — ${proposal.failureReason}`
        : 'Could not start right now. Please try again.';
    default:
      return '';
  }
}

/**
 * The in-chat confirmation card for a coding-agent session Stewra proposed running on one of the user's
 * own machines. While `pending` it shows what will run (machine / repo / agent / instruction) with
 * Start / Cancel; once resolved it collapses to a short status line. Purely presentational — the page
 * owns the API call and re-renders this from the updated message.
 *
 * This is the web twin of the mobile runner card, and one of two approve surfaces (the other being a
 * natural-language "yes" in chat): Stewra (the untrusted agent) can never start a session itself —
 * clicking Start calls the authenticated, confirm-gated POST /messages/:id/confirm-runner-session, the
 * same trusted executor the "yes" path uses.
 */
export function ProposedRunnerSessionCard({
  proposal,
  onConfirm,
  busy,
}: ProposedRunnerSessionCardProps): React.JSX.Element {
  // A `failed` start is transient (e.g. the machine dropped offline for a moment), so it stays
  // actionable: the user can retry or dismiss it. Only `sent`/`cancelled` collapse to a status line.
  const failed = proposal.status === 'failed';
  const actionable = proposal.status === 'pending' || failed;

  return (
    <div className={styles.card} data-testid="runner-session-card" data-status={proposal.status}>
      <div className={styles.header}>
        <LaptopIcon size={14} className={styles.headerIcon} />
        Run coding agent
      </div>

      <div className={styles.field}>
        <span className={styles.label}>Machine</span>
        <span className={styles.value}>{proposal.deviceName}</span>
      </div>
      <div className={styles.field}>
        <span className={styles.label}>Repo</span>
        <span className={styles.value}>{proposal.workspaceName}</span>
      </div>
      <div className={styles.field}>
        <span className={styles.label}>Agent</span>
        <span className={styles.value}>{HARNESS_LABELS[proposal.harness]}</span>
      </div>
      <p className={styles.body}>{proposal.prompt}</p>

      {/* When a start failed, show why above the buttons — then let the user retry or dismiss. */}
      {failed && (
        <p className={`${styles.status} ${styles.statusFailed}`}>{terminalMessage(proposal)}</p>
      )}

      {actionable ? (
        busy ? (
          <div className={styles.busyRow}>
            <span className={styles.spinner} data-testid="runner-session-busy">
              Starting…
            </span>
          </div>
        ) : (
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.cancel}
              disabled={busy}
              onClick={() => onConfirm('cancel')}
              data-testid="runner-session-cancel"
            >
              {failed ? 'Dismiss' : 'Cancel'}
            </button>
            <button
              type="button"
              className={styles.start}
              disabled={busy}
              onClick={() => onConfirm('start')}
              data-testid="runner-session-start"
            >
              {failed ? 'Try again' : 'Start'}
            </button>
          </div>
        )
      ) : (
        <p className={`${styles.status} ${styles.statusDone}`} data-testid="runner-session-status">
          {terminalMessage(proposal)}
        </p>
      )}
    </div>
  );
}
