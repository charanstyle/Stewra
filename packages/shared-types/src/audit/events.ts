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
  | 'process_profile';

/**
 * Actions the audit log records. `read` covers brokered data access; `insight` covers an
 * agent-produced insight; `feedback` covers the user rating an insight; `learn` covers a memory
 * saved or edited from that feedback (user-authored, auto-saved with full visibility — never silent
 * about it); `forget` covers a real deletion of a memory (per-item or forget-on-disconnect), so
 * removals are as visible as writes; `propose` covers a model-proposed (never silently written)
 * memory; `connect`/`disconnect` cover a user adding or revoking a sanctioned source; `verify`
 * covers the user proving ownership of email.
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
  | 'auth.register'
  | 'auth.login'
  | 'auth.refresh';

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
