import type { ISODateString, UUID } from '../common/base';

/**
 * Resource kinds the audit log can describe. `memory` is included now (even though memory
 * features ship post-M1/M2) so memory reads/writes log through THIS same append-only table —
 * we never build a second access/audit path (see memory-and-learning.md §5/§6). `process_profile`
 * covers the user's process/style rules (how they like work done) for the same reason.
 */
export type AuditResourceType =
  | 'auth'
  | 'system'
  | 'calendar'
  | 'gmail'
  | 'money'
  | 'memory'
  | 'process_profile'
  | 'conversation'
  | 'call'
  // A stored email (thread/message) synced from Gmail, and a Stewra-produced suggestion/nudge.
  | 'email'
  | 'suggestion'
  // A messaging channel the user can reach Stewra through (e.g. WhatsApp). Linking/unlinking one is a
  // consequential, user-visible act, so it lands in the same append-only log as everything else.
  | 'channel';

/**
 * Actions the audit log records. `read` covers brokered data access; `insight` covers an
 * agent-produced insight; `feedback` covers the user rating an insight; `learn` covers a memory
 * saved or edited from that feedback (user-authored, auto-saved with full visibility — never silent
 * about it); `forget` covers a real deletion of a memory (per-item or forget-on-disconnect), so
 * removals are as visible as writes; `propose` covers a model-proposed (never silently written)
 * memory; `connect`/`disconnect` cover a user adding or revoking a sanctioned source; `verify`
 * covers the user proving ownership of email; `view` covers an insight being surfaced to the user
 * (a passive impression), and `dismiss` covers the user closing an insight without rating it — the
 * implicit-engagement signal, so a shown-and-ignored insight is no longer invisible to the record.
 */
export type AuditAction =
  | 'read'
  | 'insight'
  | 'feedback'
  | 'learn'
  | 'forget'
  | 'propose'
  | 'connect'
  | 'disconnect'
  | 'verify'
  | 'view'
  | 'dismiss'
  | 'converse'
  | 'call'
  // Proactive-assistant actions. `sync` covers a background email sync; `suggest` a nudge produced
  // for the user; `brief` a daily briefing produced; `snooze` the user deferring a nudge; `draft` a
  // reply drafted for review (no send). `send`/`archive`/`label`/`mark_read` are the confirm-gated
  // Gmail writes — each only ever recorded after the user explicitly approved the action.
  | 'sync'
  | 'suggest'
  | 'brief'
  | 'snooze'
  | 'draft'
  | 'send'
  | 'archive'
  | 'label'
  | 'mark_read'
  // `consent` records the user typing an explicit, VERSIONED acknowledgement of a risk before a feature
  // is unlocked — currently the experimental companion-device WhatsApp channel, where the risk is a
  // permanently banned account. It is its own action, not a `connect`, precisely because what is being
  // recorded is the acceptance of a consequence rather than the attaching of a source.
  | 'consent'
  | 'auth.register'
  | 'auth.login'
  | 'auth.refresh'
  | 'auth.password_reset';

/** An append-only audit record. Rendered to the user as the plain-language activity feed. */
export interface AuditEvent {
  readonly id: UUID;
  readonly userId: UUID | null;
  readonly action: AuditAction;
  readonly resourceType: AuditResourceType;
  readonly resourceId: string | null;
  /** One-line, plain-language description shown in the activity feed. */
  readonly summary: string;
  readonly success: boolean;
  /** Minimized, non-sensitive structured context. Never raw records or secrets. */
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
  readonly createdAt: ISODateString;
}

/**
 * Input accepted by the audit writer (id/createdAt are assigned by the store).
 * `resourceId` is explicitly null when there is no resource; `metadata` is always present (`{}`
 * when none) — nothing is silently omitted.
 */
export interface NewAuditEvent {
  readonly userId: UUID | null;
  readonly action: AuditAction;
  readonly resourceType: AuditResourceType;
  readonly resourceId: string | null;
  readonly summary: string;
  readonly success: boolean;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}
