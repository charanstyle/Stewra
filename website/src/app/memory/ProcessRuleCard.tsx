import React, { useCallback, useState } from 'react';
import clsx from 'clsx';
import type {
  ProcessRule,
  ProcessRuleStatus,
  UpdateProcessRuleRequest,
} from '@stewra/shared-types';
import styles from './MemoryCard.module.css';

interface ProcessRuleCardProps {
  readonly rule: ProcessRule;
  readonly onUpdate: (id: string, patch: UpdateProcessRuleRequest) => Promise<void>;
  readonly onDelete: (id: string) => Promise<void>;
}

/**
 * One process/style rule — *how* the user likes work done, never the content. A machine-proposed
 * rule (`status='proposed'`) is Stewra asking permission: the user confirms it into `active` or mutes
 * it. Every rule is editable, hideable from recall, and hard-deletable (memory-and-learning.md §5).
 * A confirmation (proposed→active) never happens silently — it's always this explicit user tap.
 */
export const ProcessRuleCard: React.FC<ProcessRuleCardProps> = ({ rule, onUpdate, onDelete }) => {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(rule.rule);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (action: () => Promise<void>): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }, []);

  const startEdit = useCallback((): void => {
    setText(rule.rule);
    setEditing(true);
  }, [rule.rule]);

  const cancelEdit = useCallback((): void => {
    setEditing(false);
    setError(null);
  }, []);

  const saveEdit = useCallback((): void => {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      setError('The rule text can’t be empty.');
      return;
    }
    void run(async () => {
      await onUpdate(rule.id, { rule: trimmed });
      setEditing(false);
    });
  }, [text, rule.id, onUpdate, run]);

  const setStatus = useCallback(
    (status: ProcessRuleStatus): void => {
      void run(() => onUpdate(rule.id, { status }));
    },
    [rule.id, onUpdate, run],
  );

  const toggleVisible = useCallback((): void => {
    void run(() => onUpdate(rule.id, { visible: !rule.visible }));
  }, [rule.id, rule.visible, onUpdate, run]);

  const remove = useCallback((): void => {
    void run(() => onDelete(rule.id));
  }, [rule.id, onDelete, run]);

  const proposed = rule.status === 'proposed';

  return (
    <div className={styles.card}>
      <div className={styles.top}>
        <h3 className={styles.label}>{rule.dimension.replace(/_/g, ' ')}</h3>
        <div className={styles.badges}>
          <span className={styles.badge}>{rule.domain}</span>
          <span className={styles.badge}>{rule.tier}</span>
          {rule.subjectRole !== null && (
            <span className={styles.badge}>{rule.subjectRole.replace(/_/g, ' ')}</span>
          )}
          {proposed ? (
            <span className={styles.rating}>proposed</span>
          ) : (
            rule.status === 'muted' && (
              <span className={clsx(styles.badge, styles.hidden)}>muted</span>
            )
          )}
          {!rule.visible && <span className={clsx(styles.badge, styles.hidden)}>hidden</span>}
        </div>
      </div>

      {editing ? (
        <div className={styles.editRow}>
          <textarea
            className={styles.textarea}
            value={text}
            disabled={busy}
            aria-label="Rule text"
            onChange={(e) => setText(e.target.value)}
          />
        </div>
      ) : (
        <p className={styles.exemplar}>{rule.rule}</p>
      )}

      <p className={styles.guidance}>
        <span className={styles.guidanceLabel}>Confidence: </span>
        {rule.confidence}% · {rule.supportCount} observation{rule.supportCount === 1 ? '' : 's'}
      </p>

      <div className={styles.actions}>
        {editing ? (
          <>
            <button type="button" className={styles.action} disabled={busy} onClick={saveEdit}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className={styles.action} disabled={busy} onClick={cancelEdit}>
              Cancel
            </button>
          </>
        ) : (
          <>
            {proposed && (
              <button
                type="button"
                className={styles.action}
                disabled={busy}
                onClick={() => setStatus('active')}
              >
                Confirm
              </button>
            )}
            {rule.status === 'muted' ? (
              <button
                type="button"
                className={styles.action}
                disabled={busy}
                onClick={() => setStatus('active')}
              >
                Reactivate
              </button>
            ) : (
              <button
                type="button"
                className={styles.action}
                disabled={busy}
                onClick={() => setStatus('muted')}
              >
                {proposed ? 'Dismiss' : 'Mute'}
              </button>
            )}
            <button type="button" className={styles.action} disabled={busy} onClick={startEdit}>
              Edit
            </button>
            <button type="button" className={styles.action} disabled={busy} onClick={toggleVisible}>
              {rule.visible ? 'Hide from recall' : 'Use for recall'}
            </button>
            <button
              type="button"
              className={clsx(styles.action, styles.danger)}
              disabled={busy}
              onClick={remove}
            >
              Delete
            </button>
          </>
        )}
      </div>

      {error !== null && <p className={styles.error}>{error}</p>}
    </div>
  );
};

export default ProcessRuleCard;
