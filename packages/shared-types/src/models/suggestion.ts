import type { ISODateString, UUID } from '../common/base';

/**
 * A Suggestion (a "nudge") — Stewra's proactive "here's something that needs your attention, and
 * here's what you could do about it". This generalizes the proposed→confirm pattern that today only
 * covers writing-style rules (`ProcessRule` with status `proposed`): a suggestion carries a plain
 * title + rationale plus a small set of concrete OPTIONS the user can pick. Stewra proposes; the
 * user always decides. Any option that performs a Gmail write executes ONLY after explicit confirm.
 */

/** What the suggestion is about — drives the icon/copy and how it's generated. */
export type SuggestionKind =
  | 'needs_reply' // a thread whose latest message is inbound and unanswered — you owe a reply
  | 'important_unread' // an important email sitting unread
  | 'follow_up' // you sent something and haven't heard back
  | 'calendar_prep' // an upcoming meeting or a conflict worth prepping for
  | 'other';

/** Lifecycle of a suggestion. `open` awaits the user; `snoozed` is deferred; `dismissed` was
 * declined; `done` was acted on (an option executed, or the user marked it handled). */
export type SuggestionStatus = 'open' | 'snoozed' | 'dismissed' | 'done';

/**
 * The kind of action an option would perform if chosen. `none` is a pure organizational choice
 * (e.g. "Snooze", "Not important") with no side effect. The Gmail writes (`reply_email`,
 * `archive_email`, `label_email`, `mark_read`) are executed by the control-plane executor ONLY on
 * an explicit confirm, never by the background job.
 */
export type ProposedActionType =
  | 'none'
  | 'reply_email'
  | 'archive_email'
  | 'label_email'
  | 'mark_read';

/**
 * A concrete action attached to an option. `targetRefs` holds opaque control-plane references the
 * executor resolves server-side (e.g. `{ threadId }`) — never raw email content or credentials.
 */
export interface ProposedAction {
  readonly type: ProposedActionType;
  readonly targetRefs: Readonly<Record<string, string>>;
}

/** One selectable choice on a suggestion (a button in the expand-to-decide UI). */
export interface SuggestionOption {
  readonly id: UUID;
  readonly label: string;
  readonly action: ProposedAction;
}

/** A pointer back to the source that motivated the suggestion, for display + audit. Never content. */
export interface SuggestionSourceRef {
  readonly kind: 'email_thread' | 'email_message' | 'calendar_event' | 'contact';
  readonly ref: string;
  /** A short, already-minimized human label (e.g. a subject line), safe to show. */
  readonly label: string;
}

export interface Suggestion {
  readonly id: UUID;
  readonly kind: SuggestionKind;
  /** Short imperative headline (e.g. "Reply to Priya about the invoice"). */
  readonly title: string;
  /** One or two sentences on WHY Stewra surfaced this. */
  readonly rationale: string;
  readonly sourceRefs: ReadonlyArray<SuggestionSourceRef>;
  readonly options: ReadonlyArray<SuggestionOption>;
  readonly status: SuggestionStatus;
  readonly snoozedUntil: ISODateString | null;
  readonly createdAt: ISODateString;
}
