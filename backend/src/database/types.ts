import type { ColumnType, Generated } from 'kysely';
import type {
  AuditAction,
  AuditResourceType,
  BriefingSection,
  CallEndReason,
  CallKind,
  CallPushPlatform,
  CallStatus,
  ContactStatus,
  ConversationType,
  InviteStatus,
  MessageType,
  ParticipantRole,
  ProcessDomain,
  ProcessDimension,
  ProcessRuleSource,
  ProcessRuleStatus,
  ProcessTier,
  Rating,
  ReactionType,
  ResourceKind,
  SenderKind,
  SuggestionKind,
  SuggestionOption,
  SuggestionSourceRef,
  SuggestionStatus,
  UserRole,
} from '@stewra/shared-types';

/** Minimized, non-sensitive structured context stored on an audit row. */
export type AuditMetadata = Record<string, string | number | boolean | null>;

/** Generated-on-insert timestamp: never written by the app, always read as a Date. */
type CreatedAt = ColumnType<Date, never, never>;

export interface UsersTable {
  id: Generated<string>;
  email: string;
  display_name: string;
  password_hash: string;
  role: UserRole;
  /** Email-ownership flag. DB default false; flipped true when the user enters their code. */
  email_verified: Generated<boolean>;
  /** Profile photo → media_assets.id (kind='avatar'); null = no photo (clients fall back to initials). */
  avatar_asset_id: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, never, Date>;
}

export interface AuditLogTable {
  id: Generated<string>;
  /** Null ONLY for pre-auth/system events that have no user. */
  user_id: string | null;
  action: AuditAction;
  resource_type: AuditResourceType;
  /** Null ONLY when the event concerns no specific resource. */
  resource_id: string | null;
  summary: string;
  success: boolean;
  /** jsonb: written as a JSON string, read back as a parsed object. */
  metadata: ColumnType<AuditMetadata, string, string>;
  created_at: CreatedAt;
}

export interface ConnectionsTable {
  id: Generated<string>;
  user_id: string;
  provider: string;
  /** Which connected account this row is (e.g. a specific Gmail address); '' when not applicable. */
  account_email: ColumnType<string, string | undefined, string>;
  /** Handle into the vault. The actual token NEVER lives in this table. */
  vault_ref: string;
  status: string;
  /** Comma-joined OAuth scopes actually granted at last consent (migration 023). DB default ''. */
  scopes: ColumnType<string, string | undefined, string>;
  created_at: CreatedAt;
}

export interface UserPreferencesTable {
  user_id: string;
  gmail_lookback_days: number;
  // Opt-in switch for the Sent-mail style observer. Has a DB default of false (migration 011), so it
  // is optional on insert (the default fills it when omitted) and settable on update.
  learn_from_sent_mail: ColumnType<boolean, boolean | undefined, boolean>;
  // Durable email retention window (days); NULL means "not chosen" → resolved to the deploy default
  // (migration 025). Optional on insert, settable on update.
  email_retention_days: ColumnType<number | null, number | null | undefined, number | null>;
  // Whether the user shares read receipts in human chats (migration 027). NOT NULL with a DB default
  // of true, so it is optional on insert and settable on update.
  read_receipts_enabled: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, never, Date>;
}

/**
 * One row per insight the agent produces. Gives each insight a stable id (so feedback can attach to
 * it) and records the trajectory — the purpose, the advice, and the model that produced it — which
 * is what a positive rating later turns into a reusable exemplar. `purpose_norm` is the normalized
 * purpose used by lexical recall. `facts_used` is reserved for richer trajectory capture (the
 * derived facts that fed the model); null until we plumb it through the control plane.
 */
export interface AgentInsightsTable {
  id: Generated<string>;
  user_id: string;
  kind: ResourceKind;
  purpose: string;
  purpose_norm: string;
  summary: string;
  /** The model id that produced the advice ('' for claude_cli, which uses the user's own default). */
  model_id: string;
  /** jsonb array of derived-fact strings, or null. Reserved; not populated yet. */
  facts_used: ColumnType<ReadonlyArray<string> | null, string | null, string | null>;
  /** When the insight was first surfaced to the user (first-write-wins impression). Null until seen. */
  seen_at: ColumnType<Date | null, Date | null, Date | null>;
  /** When the user dismissed the insight without rating it. Null until dismissed. */
  dismissed_at: ColumnType<Date | null, Date | null, Date | null>;
  created_at: CreatedAt;
}

/**
 * One row per (user, insight) feedback. `rating` is the 5-level verdict; `reward_score` is the
 * derived scalar (RATING_REWARD) stored for analytics; `comment` is the optional free-text. Upserted
 * on the unique (user_id, insight_id) — the latest verdict wins.
 */
export interface InsightFeedbackTable {
  id: Generated<string>;
  user_id: string;
  insight_id: string;
  rating: Rating;
  reward_score: number;
  comment: string | null;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, never, Date>;
}

/**
 * A user-owned, named, searchable learning derived from feedback. `label` is the human-meaningful
 * name; `exemplar` is "what good looks like"; `guidance` is "how to do it" (from free-text). The
 * generated `search_vector` tsvector column exists in the DB but is intentionally absent here — the
 * app never reads or writes it directly; lexical recall references it via raw SQL fragments.
 */
export interface AgentMemoryTable {
  id: Generated<string>;
  user_id: string;
  label: string;
  kind: ResourceKind;
  purpose: string;
  purpose_norm: string;
  exemplar: string;
  guidance: string | null;
  rating: Rating;
  reward_score: number;
  source: Generated<'feedback' | 'user_edited'>;
  source_insight_id: string | null;
  visible: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, never, Date>;
}

/**
 * A user-owned, generalized process/style rule — *how* the user likes work done, never the content
 * (memory-and-learning.md §1 derived-facts tier). Mirrors `agent_memory`'s trust machinery but keyed
 * by (user, domain, dimension, subject) rather than a source insight. `subject_vault_ref` holds the
 * vault handle for an `identifying`-tier contact; the plaintext contact never lives here. The
 * generated `search_vector` tsvector exists in the DB but is intentionally absent here — recall
 * references it via raw SQL fragments (same pattern as `agent_memory`).
 */
export interface ProcessMemoryTable {
  id: Generated<string>;
  user_id: string;
  domain: ProcessDomain;
  dimension: ProcessDimension;
  rule: string;
  tier: Generated<ProcessTier>;
  /** Role a `relational` rule refers to (e.g. 'manager'); null otherwise. */
  subject_role: string | null;
  /** Vault handle for an `identifying`-tier contact; null otherwise. Never a plaintext contact. */
  subject_vault_ref: string | null;
  status: Generated<ProcessRuleStatus>;
  source: Generated<ProcessRuleSource>;
  confidence: Generated<number>;
  support_count: Generated<number>;
  reward_score: Generated<number>;
  /** Source provider a rule was derived from (e.g. 'google'); enables forget-on-disconnect. */
  derived_from_provider: string | null;
  visible: Generated<boolean>;
  last_reinforced_at: ColumnType<Date | null, Date | null, Date | null>;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, never, Date>;
}

/**
 * A person the user corresponds with by email (migration 024). The concrete address is vaulted
 * (`address_vault_ref`); `address_sha256` allows dedupe/lookup without holding the plaintext here.
 * `awaiting_reply` is a derived flag: the user owes this contact a reply.
 */
export interface EmailContactsTable {
  id: Generated<string>;
  user_id: string;
  connection_id: string;
  address_vault_ref: string;
  address_sha256: string;
  display_name: ColumnType<string, string | undefined, string>;
  first_seen_at: ColumnType<Date, Date | undefined, Date>;
  last_seen_at: ColumnType<Date, Date | undefined, Date>;
  message_count: ColumnType<number, number | undefined, number>;
  last_inbound_at: ColumnType<Date | null, Date | null, Date | null>;
  last_outbound_at: ColumnType<Date | null, Date | null, Date | null>;
  awaiting_reply: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, never, Date>;
}

/** An email thread (migration 024). `awaiting_reply` = latest message is inbound and unanswered. */
export interface EmailThreadsTable {
  id: Generated<string>;
  user_id: string;
  connection_id: string;
  gmail_thread_id: string;
  subject: ColumnType<string, string | undefined, string>;
  last_message_at: ColumnType<Date | null, Date | null, Date | null>;
  /** jsonb array of email_contact ids; written as a JSON string, read back parsed. */
  participant_contact_ids: ColumnType<ReadonlyArray<string>, string | undefined, string>;
  has_unread: ColumnType<boolean, boolean | undefined, boolean>;
  awaiting_reply: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, never, Date>;
}

/** One email message (migration 024). `body_ciphertext` is the AES-256-GCM envelope — never plaintext. */
export interface EmailMessagesTable {
  id: Generated<string>;
  user_id: string;
  connection_id: string;
  thread_id: string;
  gmail_message_id: string;
  /** Stored as varchar so a large uint64 historyId never loses precision as a JS number. */
  gmail_history_id: string | null;
  from_contact_id: string | null;
  direction: 'inbound' | 'outbound';
  sent_at: ColumnType<Date | null, Date | null, Date | null>;
  subject: ColumnType<string, string | undefined, string>;
  snippet: ColumnType<string, string | undefined, string>;
  /** fieldCrypto envelope of the plaintext body. '' when there was no body. */
  body_ciphertext: ColumnType<string, string | undefined, string>;
  /** jsonb array of Gmail label ids; written as a JSON string, read back parsed. */
  label_ids: ColumnType<ReadonlyArray<string>, string | undefined, string>;
  created_at: CreatedAt;
}

/** One sync-state row per connection (migration 024), driving resumable backfill + incremental sync. */
export interface EmailSyncStateTable {
  connection_id: string;
  user_id: string;
  last_history_id: ColumnType<string | null, string | null | undefined, string | null>;
  backfill_cursor: ColumnType<string | null, string | null | undefined, string | null>;
  backfill_complete: ColumnType<boolean, boolean | undefined, boolean>;
  last_synced_at: ColumnType<Date | null, Date | null, Date | null>;
  retention_days: number;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, never, Date>;
}

/** One current briefing per user (migration 026); upserted each run. */
export interface BriefingsTable {
  id: Generated<string>;
  user_id: string;
  summary: ColumnType<string, string | undefined, string>;
  /** jsonb array of BriefingSection; written as a JSON string, read back parsed. */
  sections: ColumnType<ReadonlyArray<BriefingSection>, string | undefined, string>;
  generated_at: ColumnType<Date, Date | undefined, Date>;
  created_at: CreatedAt;
}

/**
 * A proactive nudge (migration 026). `dedup_key` gives it a stable identity so a re-computation
 * updates the open one in place and never clobbers a user-acted one. `source_refs`/`options` are
 * jsonb, written as JSON strings and read back parsed.
 */
export interface SuggestionsTable {
  id: Generated<string>;
  user_id: string;
  dedup_key: string;
  kind: SuggestionKind;
  title: string;
  rationale: ColumnType<string, string | undefined, string>;
  source_refs: ColumnType<ReadonlyArray<SuggestionSourceRef>, string | undefined, string>;
  options: ColumnType<ReadonlyArray<SuggestionOption>, string | undefined, string>;
  status: ColumnType<SuggestionStatus, SuggestionStatus | undefined, SuggestionStatus>;
  snoozed_until: ColumnType<Date | null, Date | null, Date | null>;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, never, Date>;
}

export interface MigrationsTable {
  name: string;
  applied_at: CreatedAt;
}

export interface VaultSecretsTable {
  id: Generated<string>;
  /** AES-256-GCM envelope: base64(iv).base64(authTag).base64(ciphertext). Never plaintext. */
  ciphertext: string;
  created_at: CreatedAt;
}

export interface EmailVerificationCodesTable {
  id: Generated<string>;
  user_id: string;
  /** The numeric code the user must enter. */
  code: string;
  /** Address the code was emailed to (snapshot at issue time). */
  email: string;
  /** Set on insert, read back; never updated. */
  expires_at: ColumnType<Date, Date, never>;
  /** DB default false; flipped true once the code is consumed. */
  used: ColumnType<boolean, boolean | undefined, boolean>;
  /** DB default 0; incremented on each failed entry until the lockout cap. */
  attempts: ColumnType<number, number | undefined, number>;
  created_at: CreatedAt;
}

/** Password-reset codes: same shape as verification codes, separate table (see migration 022). */
export interface PasswordResetCodesTable {
  id: Generated<string>;
  user_id: string;
  /** The numeric code the user must enter to reset their password. */
  code: string;
  /** Address the code was emailed to (snapshot at issue time). */
  email: string;
  /** Set on insert, read back; never updated. */
  expires_at: ColumnType<Date, Date, never>;
  /** DB default false; flipped true once the code is consumed. */
  used: ColumnType<boolean, boolean | undefined, boolean>;
  /** DB default 0; incremented on each failed entry until the lockout cap. */
  attempts: ColumnType<number, number | undefined, number>;
  created_at: CreatedAt;
}

/** jsonb bag for message/call structured context. Never raw records or secrets. */
export type JsonMetadata = Record<string, string | number | boolean | null>;

/**
 * A directed contact edge (migration 014). One row per direction so "is a contact" is a symmetric
 * lookup; `status='blocked'` is a one-way suppression the owner sets.
 */
export interface ContactsTable {
  id: Generated<string>;
  owner_id: string;
  contact_user_id: string;
  status: ColumnType<ContactStatus, ContactStatus | undefined, ContactStatus>;
  created_at: CreatedAt;
}

/** An invitation to connect, addressed to an email (migration 014). `token` never leaves the server. */
export interface ContactInvitesTable {
  id: Generated<string>;
  inviter_id: string;
  invitee_email: string;
  /** Resolved when the email already belongs to a user; null otherwise. */
  invitee_user_id: string | null;
  status: ColumnType<InviteStatus, InviteStatus | undefined, InviteStatus>;
  token: string;
  created_at: CreatedAt;
  responded_at: ColumnType<Date | null, Date | null, Date | null>;
}

/** A conversation thread (migration 015). `type='stewra_ai'` is the singleton assistant thread. */
export interface ConversationsTable {
  id: Generated<string>;
  type: ConversationType;
  title: string | null;
  avatar_url: string | null;
  created_by: string;
  last_message_at: ColumnType<Date, Date | undefined, Date>;
  is_archived: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: CreatedAt;
}

/** Membership + per-user read state (migration 015). `left_at IS NULL` = still a participant. */
export interface ConversationParticipantsTable {
  id: Generated<string>;
  conversation_id: string;
  user_id: string;
  role: ColumnType<ParticipantRole, ParticipantRole | undefined, ParticipantRole>;
  is_muted: ColumnType<boolean, boolean | undefined, boolean>;
  last_read_at: ColumnType<Date | null, Date | null, Date | null>;
  joined_at: ColumnType<Date, Date | undefined, Date>;
  left_at: ColumnType<Date | null, Date | null, Date | null>;
}

/**
 * One message (migration 016). `sender_id` is null for assistant turns (sender_kind='assistant').
 * `audio_url`/`transcript` back the heard-and-read Stewra reply.
 */
export interface MessagesTable {
  id: Generated<string>;
  conversation_id: string;
  sender_id: string | null;
  sender_kind: ColumnType<SenderKind, SenderKind | undefined, SenderKind>;
  message_type: ColumnType<MessageType, MessageType | undefined, MessageType>;
  content: string | null;
  media_url: string | null;
  media_type: string | null;
  media_duration_sec: number | null;
  thumbnail_url: string | null;
  audio_url: string | null;
  transcript: string | null;
  metadata: ColumnType<JsonMetadata, string | undefined, string>;
  reply_to_message_id: string | null;
  is_edited: ColumnType<boolean, boolean | undefined, boolean>;
  is_deleted: ColumnType<boolean, boolean | undefined, boolean>;
  delivered_at: ColumnType<Date | null, Date | null, Date | null>;
  created_at: CreatedAt;
}

/** One reaction per (message, user, type) (migration 017). */
export interface MessageReactionsTable {
  id: Generated<string>;
  message_id: string;
  user_id: string;
  reaction_type: ReactionType;
  created_at: CreatedAt;
}

/** Per-recipient read receipt (migration 017); row presence = that user read that message. */
export interface MessageReadReceiptsTable {
  id: Generated<string>;
  message_id: string;
  user_id: string;
  read_at: ColumnType<Date, Date | undefined, Date>;
}

/** One row per call attempt (migration 018). Media never touches the server; this is the record. */
export interface CallSessionsTable {
  id: Generated<string>;
  conversation_id: string;
  initiated_by: string;
  call_type: CallKind;
  status: ColumnType<CallStatus, CallStatus | undefined, CallStatus>;
  started_at: ColumnType<Date | null, Date | null, Date | null>;
  ended_at: ColumnType<Date | null, Date | null, Date | null>;
  duration_sec: number | null;
  end_reason: CallEndReason | null;
  metadata: ColumnType<JsonMetadata, string | undefined, string>;
  created_at: CreatedAt;
}

/** Per-participant call state (migration 018). Enables the group-call mesh. */
export interface CallParticipantsTable {
  id: Generated<string>;
  call_id: string;
  user_id: string;
  joined_at: ColumnType<Date | null, Date | null, Date | null>;
  left_at: ColumnType<Date | null, Date | null, Date | null>;
  audio_enabled: ColumnType<boolean, boolean | undefined, boolean>;
  video_enabled: ColumnType<boolean, boolean | undefined, boolean>;
}

/** Push routing for background ringing (migration 019). One row per (user, platform). */
export interface CallPushTokensTable {
  id: Generated<string>;
  user_id: string;
  platform: CallPushPlatform;
  voip_token: string | null;
  fcm_token: string | null;
  created_at: ColumnType<Date, Date | undefined, Date>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

/** One stored binary (migration 021), owner-scoped so `GET /media/:id` can authorize before streaming. */
export interface MediaAssetsTable {
  id: Generated<string>;
  owner_id: string;
  conversation_id: string | null;
  kind: 'voice_in' | 'tts_out' | 'image' | 'video' | 'audio' | 'file' | 'avatar';
  path: string;
  mime: string;
  bytes: ColumnType<bigint, bigint | number, never>;
  created_at: CreatedAt;
}

export interface Database {
  users: UsersTable;
  audit_log: AuditLogTable;
  connections: ConnectionsTable;
  user_preferences: UserPreferencesTable;
  migrations: MigrationsTable;
  vault_secrets: VaultSecretsTable;
  email_verification_codes: EmailVerificationCodesTable;
  password_reset_codes: PasswordResetCodesTable;
  agent_insights: AgentInsightsTable;
  insight_feedback: InsightFeedbackTable;
  agent_memory: AgentMemoryTable;
  process_memory: ProcessMemoryTable;
  email_contacts: EmailContactsTable;
  email_threads: EmailThreadsTable;
  email_messages: EmailMessagesTable;
  email_sync_state: EmailSyncStateTable;
  briefings: BriefingsTable;
  suggestions: SuggestionsTable;
  contacts: ContactsTable;
  contact_invites: ContactInvitesTable;
  conversations: ConversationsTable;
  conversation_participants: ConversationParticipantsTable;
  messages: MessagesTable;
  message_reactions: MessageReactionsTable;
  message_read_receipts: MessageReadReceiptsTable;
  call_sessions: CallSessionsTable;
  call_participants: CallParticipantsTable;
  call_push_tokens: CallPushTokensTable;
  media_assets: MediaAssetsTable;
}
