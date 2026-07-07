import React, { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import type { Suggestion, SuggestionKind, SuggestionOption } from '@stewra/shared-types';
import { api, ApiError } from '../../services/api';
import {
  CalendarIcon,
  ChatBubbleIcon,
  ChevronDownIcon,
  ClockIcon,
  MailIcon,
  ReplyIcon,
  SparkleIcon,
} from '../../components/icons/Icons';
import styles from './NudgeCard.module.css';

interface NudgeCardProps {
  readonly suggestion: Suggestion;
  /** Tells the page this suggestion left the "open" list (snoozed, dismissed, or done). */
  readonly onResolved: (id: string) => void;
}

function describeError(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong';
}

/** Icon that identifies what kind of nudge this is, at a glance in the collapsed card. */
function kindIcon(kind: SuggestionKind): React.JSX.Element {
  switch (kind) {
    case 'needs_reply':
      return <ReplyIcon size={18} />;
    case 'important_unread':
      return <MailIcon size={18} />;
    case 'follow_up':
      return <ClockIcon size={18} />;
    case 'calendar_prep':
      return <CalendarIcon size={18} />;
    case 'other':
      return <SparkleIcon size={18} />;
  }
}

const KIND_LABEL: Readonly<Record<SuggestionKind, string>> = {
  needs_reply: 'Needs a reply',
  important_unread: 'Important, unread',
  follow_up: 'Waiting on a reply',
  calendar_prep: 'Calendar prep',
  other: 'Worth a look',
};

/** 9am local time tomorrow, as the ISO string the snooze API expects. */
function tomorrowAt9AM(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

/**
 * One proactive nudge — collapsed to a kind icon, title, rationale, and source labels; expands into
 * a decision prompt with the suggestion's options, a free-text "add info" box, and a deep-link into
 * chat. Generalizes ProcessRuleCard's busy/error/edit state machine (memory/ProcessRuleCard.tsx) for
 * a card whose "edit" is really "decide". Reply-drafting is read-only in this phase — Stewra never
 * sends on the user's behalf here, it only prepares a draft for review in Chat.
 */
export const NudgeCard: React.FC<NudgeCardProps> = ({ suggestion, onResolved }) => {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const [addedInfo, setAddedInfo] = useState('');
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (action: () => Promise<void>): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const toggleExpanded = useCallback((): void => {
    setExpanded((prev) => !prev);
  }, []);

  const selectOption = useCallback(
    (option: SuggestionOption): void => {
      setSelectedOptionId(option.id);
      setDraft(null);
      setError(null);
      // Only reply drafting has a real action in this read-only phase — the organizational options
      // ("none": snooze/dismiss-style choices) are handled by the dedicated buttons below instead.
      if (option.action.type !== 'reply_email') {
        return;
      }
      const trimmed = addedInfo.trim();
      void run(async () => {
        const res = await api.requestDraft(suggestion.id, {
          optionId: option.id,
          ...(trimmed.length > 0 ? { addedInfo: trimmed } : {}),
        });
        setDraft(res.draft);
      });
    },
    [addedInfo, suggestion.id, run],
  );

  const snooze = useCallback((): void => {
    void run(async () => {
      await api.snoozeSuggestion(suggestion.id, { until: tomorrowAt9AM() });
      onResolved(suggestion.id);
    });
  }, [suggestion.id, onResolved, run]);

  const dismiss = useCallback((): void => {
    void run(async () => {
      await api.dismissSuggestion(suggestion.id);
      onResolved(suggestion.id);
    });
  }, [suggestion.id, onResolved, run]);

  const markDone = useCallback((): void => {
    void run(async () => {
      await api.markSuggestionDone(suggestion.id);
      onResolved(suggestion.id);
    });
  }, [suggestion.id, onResolved, run]);

  const chatAboutThis = useCallback((): void => {
    const trimmed = addedInfo.trim();
    void run(async () => {
      await api.chatAboutSuggestion(suggestion.id, trimmed.length > 0 ? { message: trimmed } : {});
      navigate('/stewra');
    });
  }, [addedInfo, suggestion.id, navigate, run]);

  return (
    <div className={styles.card}>
      <button
        type="button"
        className={styles.header}
        aria-expanded={expanded}
        onClick={toggleExpanded}
      >
        <span className={styles.kindIcon} aria-hidden="true">
          {kindIcon(suggestion.kind)}
        </span>
        <span className={styles.headerText}>
          <span className={styles.kindLabel}>{KIND_LABEL[suggestion.kind]}</span>
          <span className={styles.title}>{suggestion.title}</span>
          <span className={styles.rationale}>{suggestion.rationale}</span>
          {suggestion.sourceRefs.length > 0 && (
            <span className={styles.sourceRow}>
              {suggestion.sourceRefs.map((ref, i) => (
                <span key={`${ref.kind}-${ref.ref}-${i}`} className={styles.sourceBadge}>
                  {ref.label}
                </span>
              ))}
            </span>
          )}
        </span>
        <span className={clsx(styles.chevron, expanded && styles.chevronOpen)} aria-hidden="true">
          <ChevronDownIcon size={18} />
        </span>
      </button>

      {expanded && (
        <div className={styles.body}>
          {suggestion.options.length > 0 && (
            <div className={styles.optionsRow} role="group" aria-label="Choose an option">
              {suggestion.options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={clsx(
                    styles.optionButton,
                    selectedOptionId === option.id && styles.optionButtonSelected,
                  )}
                  disabled={busy}
                  onClick={() => selectOption(option)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}

          {draft !== null && (
            <div className={styles.draftBox}>
              <p className={styles.draftNote}>Draft ready — review it in Chat.</p>
              <textarea className={styles.draftText} value={draft} readOnly aria-label="Drafted reply" />
            </div>
          )}

          <div className={styles.addInfoRow}>
            <label className={styles.addInfoLabel} htmlFor={`nudge-info-${suggestion.id}`}>
              Add info
            </label>
            <textarea
              id={`nudge-info-${suggestion.id}`}
              className={styles.textarea}
              placeholder="Anything Stewra should know before deciding or drafting? (optional)"
              value={addedInfo}
              disabled={busy}
              onChange={(e) => setAddedInfo(e.target.value)}
            />
          </div>

          <div className={styles.actions}>
            <button type="button" className={styles.action} disabled={busy} onClick={snooze}>
              Snooze to tomorrow
            </button>
            <button type="button" className={styles.action} disabled={busy} onClick={dismiss}>
              Dismiss
            </button>
            <button type="button" className={styles.action} disabled={busy} onClick={markDone}>
              Mark done
            </button>
            <button
              type="button"
              className={clsx(styles.action, styles.chatAction)}
              disabled={busy}
              onClick={chatAboutThis}
            >
              <ChatBubbleIcon size={14} />
              Chat with Stewra about this
            </button>
          </div>

          {error !== null && <p className={styles.error}>{error}</p>}
        </div>
      )}
    </div>
  );
};

export default NudgeCard;
