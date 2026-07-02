import React, { useCallback, useState } from 'react';
import clsx from 'clsx';
import type { AgentMemory, UpdateMemoryRequest } from '@stewra/shared-types';
import styles from './MemoryCard.module.css';

interface MemoryCardProps {
  readonly memory: AgentMemory;
  readonly onUpdate: (id: string, patch: UpdateMemoryRequest) => Promise<void>;
  readonly onDelete: (id: string) => Promise<void>;
}

/**
 * One learned memory, fully visible and editable: rename the searchable label, edit the guidance,
 * toggle whether it's used for recall, or delete it outright (memory is a user-owned trust asset).
 */
export const MemoryCard: React.FC<MemoryCardProps> = ({ memory, onUpdate, onDelete }) => {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(memory.label);
  const [guidance, setGuidance] = useState(memory.guidance ?? '');
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
    setLabel(memory.label);
    setGuidance(memory.guidance ?? '');
    setEditing(true);
  }, [memory.label, memory.guidance]);

  const cancelEdit = useCallback((): void => {
    setEditing(false);
    setError(null);
  }, []);

  const saveEdit = useCallback((): void => {
    const trimmedLabel = label.trim();
    if (trimmedLabel.length === 0) {
      setError('A name is required.');
      return;
    }
    const trimmedGuidance = guidance.trim();
    void run(async () => {
      await onUpdate(memory.id, {
        label: trimmedLabel,
        guidance: trimmedGuidance.length > 0 ? trimmedGuidance : null,
      });
      setEditing(false);
    });
  }, [label, guidance, memory.id, onUpdate, run]);

  const toggleVisible = useCallback((): void => {
    void run(() => onUpdate(memory.id, { visible: !memory.visible }));
  }, [memory.id, memory.visible, onUpdate, run]);

  const remove = useCallback((): void => {
    void run(() => onDelete(memory.id));
  }, [memory.id, onDelete, run]);

  return (
    <div className={styles.card}>
      <div className={styles.top}>
        {editing ? (
          <input
            className={styles.input}
            value={label}
            disabled={busy}
            aria-label="Memory name"
            onChange={(e) => setLabel(e.target.value)}
          />
        ) : (
          <h3 className={styles.label}>{memory.label}</h3>
        )}
        <div className={styles.badges}>
          <span className={styles.badge}>{memory.kind}</span>
          <span className={styles.rating}>{memory.rating}</span>
          {!memory.visible && <span className={clsx(styles.badge, styles.hidden)}>hidden</span>}
        </div>
      </div>

      <p className={styles.exemplar}>{memory.exemplar}</p>

      {editing ? (
        <div className={styles.editRow}>
          <textarea
            className={styles.textarea}
            value={guidance}
            disabled={busy}
            placeholder="Guidance — how you'd want this done (optional)"
            aria-label="Guidance"
            onChange={(e) => setGuidance(e.target.value)}
          />
        </div>
      ) : (
        memory.guidance !== null && (
          <p className={styles.guidance}>
            <span className={styles.guidanceLabel}>Guidance: </span>
            {memory.guidance}
          </p>
        )
      )}

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
            <button type="button" className={styles.action} disabled={busy} onClick={startEdit}>
              Edit
            </button>
            <button type="button" className={styles.action} disabled={busy} onClick={toggleVisible}>
              {memory.visible ? 'Hide from recall' : 'Use for recall'}
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

export default MemoryCard;
