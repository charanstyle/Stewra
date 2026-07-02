import React, { useCallback, useState } from 'react';
import clsx from 'clsx';
import { RATINGS, type Rating } from '@stewra/shared-types';
import { api, ApiError } from '../../services/api';
import styles from './FeedbackControl.module.css';

interface FeedbackControlProps {
  /** The insight this feedback attaches to (POST /insights/:insightId/feedback). */
  readonly insightId: string;
}

function describeError(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Could not save your feedback';
}

/**
 * The user's verdict on one insight: a 5-level rating plus optional free-text. This is the reward
 * signal the learning loop remembers — a positive rating or any free-text becomes a searchable memory.
 */
export const FeedbackControl: React.FC<FeedbackControlProps> = ({ insightId }) => {
  const [rating, setRating] = useState<Rating | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async (): Promise<void> => {
    if (rating === null) {
      setError('Pick a rating first.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const trimmed = comment.trim();
      await api.submitFeedback(insightId, {
        rating,
        ...(trimmed.length > 0 ? { comment: trimmed } : {}),
      });
      setSubmitted(true);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }, [insightId, rating, comment]);

  if (submitted) {
    return (
      <div className={styles.wrap}>
        <p className={styles.thanks}>
          ✓ Thanks — Stewra will remember this to do better next time.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <h3 className={styles.title}>How was that?</h3>
      <p className={styles.hint}>
        Your rating and anything you add helps Stewra learn what good looks like for you.
      </p>

      <div className={styles.ratings} role="group" aria-label="Rate this insight">
        {RATINGS.map((r) => (
          <button
            key={r}
            type="button"
            className={clsx(styles.rating, rating === r && styles.ratingActive)}
            aria-pressed={rating === r}
            disabled={busy}
            onClick={() => setRating(r)}
          >
            {r}
          </button>
        ))}
      </div>

      <textarea
        className={styles.comment}
        placeholder="Anything else? (optional) — e.g. what you'd want done differently"
        value={comment}
        disabled={busy}
        onChange={(e) => setComment(e.target.value)}
      />

      <div className={styles.footer}>
        <button type="button" className={styles.submit} disabled={busy} onClick={() => void submit()}>
          {busy ? 'Saving…' : 'Send feedback'}
        </button>
        {error !== null && <p className={styles.error}>{error}</p>}
      </div>
    </div>
  );
};

export default FeedbackControl;
