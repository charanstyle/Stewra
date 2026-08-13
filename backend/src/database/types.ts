import type { ColumnType, Generated } from 'kysely';
import type {
  AuditAction,
  AuditResourceType,
  BridgeWaState,
  BriefingSection,
  CallEndReason,
  CallKind,
  CallPushPlatform,
  CallStatus,
  ChannelAccountStatus,
  CommerceMessageDirection,
  CommerceMessageStatus,
  CommercePlatform,
  ConsentPurpose,
  ConsentSource,
  OptinLinkStatus,
  ConsentState,
  ContactStatus,
  ConversationType,
  InviteStatus,
  OrgInviteStatus,
  OrgRole,
  OrgStatus,
  MessageType,
  MessagingChannel,
  ParticipantRole,
  PushPlatform,
  ProcessDomain,
  ProcessDimension,
  ProcessRuleSource,
  ProcessRuleStatus,
  ProcessTier,
  SuppressionReason,
  CommerceJobKind,
  ContactImportSkipReason,
  ContactImportStatus,
  CommerceJobStatus,
  MessageCostState,
  MessagePricingCategory,
  RateUnit,
  TemplateCategory,
  TemplateStatus,
  BroadcastStatus,
  BroadcastRecipientStatus,
  Rating,
  ReactionType,
  ResourceKind,
  RunnerContainerStatus,
  RunnerDeviceKind,
  RunnerHarnessId,
  RunnerHarnessInfo,
  RunnerSessionStatus,
  RunnerWorkspace,
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
  // Approve-to-send email over WhatsApp opt-in (migration 030). NOT NULL with a DB default of false, so
  // it is optional on insert (default fills it) and settable on update.
  send_email_over_whatsapp: ColumnType<boolean, boolean | undefined, boolean>;
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

/** Any JSON-representable value — scalars, arrays, or nested objects. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue };

/**
 * jsonb bag for message/call structured context. Never raw records or secrets. Values may be nested
 * JSON (e.g. a message's `proposedEmail` draft), not just scalars.
 */
export type JsonMetadata = Record<string, JsonValue>;

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

/**
 * General push routing for actionable notifications (migration 031; FCM column added in 032). One row
 * per (user, platform). Android stores a raw FCM device token (`fcm_token`) so the approval prompt can
 * be sent data-only; iOS stores an Expo push token (`expo_token`). Exactly one is set per row — the
 * table CHECK enforces at-least-one, and each platform only ever writes its own column.
 */
export interface PushTokensTable {
  id: Generated<string>;
  user_id: string;
  platform: PushPlatform;
  expo_token: ColumnType<string | null, string | null | undefined, string | null>;
  fcm_token: ColumnType<string | null, string | null | undefined, string | null>;
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

/**
 * Which external channel address belongs to which Stewra user (migration 028). This map is what turns an
 * inbound webhook — which carries only a phone number — into an authenticated userId, so a row is a
 * security assertion and is minted ONLY by the verified link flow.
 */
export interface ChannelIdentitiesTable {
  id: Generated<string>;
  user_id: string;
  channel: MessagingChannel;
  /** For WhatsApp, Meta's `wa_id`: an E.164 phone number with no leading '+'. */
  external_id: string;
  created_at: CreatedAt;
}

/** Single-use, short-lived code proving the phone holder is also the logged-in user (migration 028). */
export interface ChannelLinkCodesTable {
  id: Generated<string>;
  user_id: string;
  channel: MessagingChannel;
  code: string;
  expires_at: ColumnType<Date, Date, never>;
  consumed_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  created_at: CreatedAt;
}

/** Seen provider message ids (migration 028) — the idempotency lock against Meta's 7-day webhook retries. */
export interface ChannelInboundMessagesTable {
  id: Generated<string>;
  channel: MessagingChannel;
  /** Meta's `messages[].id` (`wamid...`), stable across redeliveries of the same message. */
  provider_message_id: string;
  received_at: CreatedAt;
}

/**
 * The typed, versioned consent behind the experimental companion-device channel (migration 029). Stored
 * verbatim, never updated — it is the record of what this user actually agreed to, in their own typing.
 */
export interface BridgeConsentsTable {
  id: Generated<string>;
  user_id: string;
  version: number;
  sentence: string;
  consented_at: CreatedAt;
}

/**
 * A registered Stewra Bridge install on a user's own machine (migration 029). Note the absent
 * `revoked_at`: revoking DELETES the row, so a revoked credential cannot linger behind a filter that
 * some future query forgets to apply.
 */
export interface BridgeDevicesTable {
  id: Generated<string>;
  user_id: string;
  name: string;
  /** SHA-256 of the bridge token. The plaintext token exists only in the pairing response. */
  token_hash: string;
  app_version: string;
  wa_state: BridgeWaState;
  consent_version: number;
  consented_at: ColumnType<Date, Date, never>;
  last_seen_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  created_at: CreatedAt;
}

/**
 * A chat the user has ALLOWED Stewra to see (migration 029). The row's existence is the permission —
 * every other chat is dropped on the user's own machine and never reaches this database. Scoped to the
 * user rather than the forwarding device: replacing a laptop should not erase what you allowed.
 */
export interface WhatsappChatsTable {
  id: Generated<string>;
  user_id: string;
  /** Keyed HMAC of the JID — a deterministic handle that a phone number's low entropy can't unmask. */
  jid_hmac: string;
  jid_ciphertext: string;
  display_name_ciphertext: Generated<string>;
  is_self_chat: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

/** A message in an allowed chat, body encrypted at rest exactly as an email body is (migration 029). */
export interface WhatsappMessagesTable {
  id: Generated<string>;
  user_id: string;
  chat_id: string;
  /** Baileys' `key.id` — unique per chat, not globally. */
  provider_message_id: string;
  direction: 'inbound' | 'outbound';
  from_me: Generated<boolean>;
  body_ciphertext: Generated<string>;
  sent_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  created_at: CreatedAt;
}

/**
 * The confirm-gated send queue (migration 029). Enqueued first, delivered when a bridge comes online, so
 * a shut laptop costs latency and never correctness. `device_id` is which bridge DELIVERED it — null
 * while pending, and nulled again if that device is later revoked, so an approved send is never lost.
 */
export interface WhatsappOutboundTable {
  id: Generated<string>;
  user_id: string;
  chat_id: string;
  device_id: ColumnType<string | null, string | null | undefined, string | null>;
  body_ciphertext: string;
  status: Generated<'pending' | 'sent' | 'failed'>;
  attempts: Generated<number>;
  provider_message_id: ColumnType<string | null, string | null | undefined, string | null>;
  last_error: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: CreatedAt;
  sent_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
}

/**
 * A registered Stewra Runner install (migration 033), on the user's own machine OR in a container Stewra
 * hosts (migration 037 — `kind`). Like `bridge_devices`, there is no `revoked_at`: revoking DELETES the
 * row. `harnesses`/`workspaces` are the runner's last-reported capabilities (jsonb), written as JSON
 * strings and read back parsed.
 *
 * The `container_*` columns are populated only for `kind='hosted'` and describe what Stewra last SAW of
 * the container — the provisioner's view of Docker is the source of truth, and the hourly reconcile is
 * what corrects drift (e.g. after a host reboot).
 */
export interface RunnerDevicesTable {
  id: Generated<string>;
  user_id: string;
  name: string;
  /** SHA-256 of the runner token. The plaintext token exists only in the pairing response. */
  token_hash: string;
  app_version: string;
  os: Generated<string>;
  harnesses: ColumnType<readonly RunnerHarnessInfo[], string | undefined, string>;
  workspaces: ColumnType<readonly RunnerWorkspace[], string | undefined, string>;
  /** 'local' (the user's machine) or 'hosted' (a container Stewra provisioned). Backfilled 'local'. */
  kind: Generated<RunnerDeviceKind>;
  /** The provisioner's handle on the container. NULL exactly when `kind='local'` (checked in the DB). */
  container_name: ColumnType<string | null, string | null | undefined, string | null>;
  container_status: ColumnType<
    RunnerContainerStatus | null,
    RunnerContainerStatus | null | undefined,
    RunnerContainerStatus | null
  >;
  container_last_started_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  last_seen_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  created_at: CreatedAt;
}

/**
 * Single-use runner pairing codes (migration 033). A dedicated table rather than `channel_link_codes`,
 * whose `channel` is a MessagingChannel — a runner is not a messaging channel. The redemption UPDATE's
 * WHERE clause is the atomic guard; there is no `revoked` flag, only `consumed_at`.
 */
export interface RunnerPairCodesTable {
  id: Generated<string>;
  user_id: string;
  code: string;
  expires_at: ColumnType<Date, Date, Date>;
  consumed_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  created_at: CreatedAt;
}

/**
 * One coding session hosted by a runner (migration 034). `id` is the server-minted session id that also
 * travels on the wire. `device_id` is a plain uuid, NOT a foreign key: revoking a device deletes its
 * `runner_devices` row, but the session history must survive that, so `device_name`/`workspace_name` are
 * snapshotted for display. `status` is the RunnerSessionStatus union; `harness` the RunnerHarnessId union.
 */
export interface RunnerSessionsTable {
  id: Generated<string>;
  user_id: string;
  device_id: string;
  device_name: Generated<string>;
  harness: RunnerHarnessId;
  workspace_id: string;
  workspace_name: Generated<string>;
  status: RunnerSessionStatus;
  prompt: string;
  summary: ColumnType<string | null, string | null | undefined, string | null>;
  error: ColumnType<string | null, string | null | undefined, string | null>;
  // Git follow-through (migration 035): the isolated branch, its committed tip, push state, and any PR.
  branch: ColumnType<string | null, string | null | undefined, string | null>;
  head_sha: ColumnType<string | null, string | null | undefined, string | null>;
  pr_url: ColumnType<string | null, string | null | undefined, string | null>;
  pushed: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, Date | undefined, Date>;
  ended_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
}

/**
 * The user's GitHub App installation (migration 036) — the one piece of GitHub state at rest, and it
 * holds NO credential: installation tokens are minted on demand from the App's private key and cached
 * in memory only. One row per user, and an installation can belong to only one user (both unique).
 */
export interface GithubAppInstallationsTable {
  id: Generated<string>;
  user_id: string;
  installation_id: ColumnType<string, number | string, number | string>;
  account_login: string;
  created_at: CreatedAt;
}

/**
 * The commerce plane's tenant (migration 038). Every table below this one is scoped by `org_id`, in
 * the way every table above it is scoped by `user_id`. `created_by` is provenance only — it confers
 * no rights, so an organization survives its founder leaving.
 */
export interface OrganizationsTable {
  id: Generated<string>;
  name: string;
  slug: string;
  status: Generated<OrgStatus>;
  created_by: string;
  created_at: CreatedAt;
}

/**
 * The ONLY join between an authenticated user and an organization's data (migration 038). Unique on
 * (org_id, user_id), because an authorization check that can return two roles is a vulnerability.
 */
export interface OrgMembersTable {
  id: Generated<string>;
  org_id: string;
  user_id: string;
  role: OrgRole;
  created_at: CreatedAt;
}

/**
 * An invitation to join an organization (migration 038). Like the bridge and runner device tokens,
 * `token_hash` is a SHA-256 and the plaintext exists only in the creation response — this credential
 * grants access to a business's entire customer list.
 */
export interface OrgInvitesTable {
  id: Generated<string>;
  org_id: string;
  email: string;
  role: OrgRole;
  status: Generated<OrgInviteStatus>;
  token_hash: string;
  invited_by: string;
  expires_at: ColumnType<Date, Date, never>;
  accepted_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  created_at: CreatedAt;
}

/**
 * Platform-reported facts about a connected account that are worth showing but never worth trusting
 * for routing — routing always goes through `external_account_id`. Every field is optional because
 * Meta populates them at different points in the connection lifecycle.
 */
export interface ChannelAccountMeta {
  /** The Meta Business (portfolio) id that owns the WABA. */
  readonly businessId?: string;
  /** The display name Meta has verified for the number, e.g. "Acme Bakery". */
  readonly verifiedName?: string;
  /** Meta's rolling quality rating for the number: GREEN | YELLOW | RED. */
  readonly qualityRating?: string;
  /** The messaging tier cap, e.g. TIER_1K — how many unique customers may be started per day. */
  readonly messagingTier?: string;
}

/**
 * A per-organization messaging account (migration 039) — what replaces the deploy-wide `WHATSAPP_*`
 * env vars for the commerce plane. `credential_ref` is a vault handle, not a credential: a dump of
 * this table yields no ability to send as anybody.
 */
export interface ChannelAccountsTable {
  id: Generated<string>;
  org_id: string;
  platform: CommercePlatform;
  /** The WABA id for WhatsApp — the key an inbound webhook is routed by. Unique per platform. */
  external_account_id: string;
  phone_number_id: ColumnType<string | null, string | null | undefined, string | null>;
  display_name: Generated<string>;
  /**
   * The number in E.164, for building a `wa.me` link (migration 049). NULL when Meta reported none —
   * distinct from `display_name`, which falls back to the WABA name and is therefore a label rather
   * than an address.
   */
  display_phone_number: ColumnType<string | null, string | null | undefined, string | null>;
  /** → vault_secrets.id. Deliberately not a foreign key; see the migration for why. */
  credential_ref: string;
  status: Generated<ChannelAccountStatus>;
  error_detail: ColumnType<string | null, string | null | undefined, string | null>;
  /** jsonb: written as a JSON string, read back as a parsed object. */
  meta: ColumnType<ChannelAccountMeta, string | undefined, string>;
  /**
   * When the vaulted credential stops working (migration 041). NULL means Meta reported no expiry
   * — a real answer, not a missing one, and the sweep skips those rows rather than treating NULL as
   * "expires now".
   */
  credential_expires_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  /**
   * The WABA's billing currency as Meta reports it (migration 051) — load-bearing, unlike `meta`:
   * it selects the rate card every message on this account is billed from. NULL means Meta
   * reported none, and such messages rate as `unrated_no_currency` rather than being guessed.
   */
  billing_currency: ColumnType<string | null, string | null | undefined, string | null>;
  connected_at: CreatedAt;
}

/** Seen provider message ids for the commerce plane (migration 039) — the idempotency lock against
 * Meta's 7-day webhook retries. Separate from `channel_inbound_messages`, whose `channel` is a
 * MessagingChannel rather than a CommercePlatform. */
export interface CommerceInboundMessagesTable {
  id: Generated<string>;
  platform: CommercePlatform;
  provider_message_id: string;
  received_at: CreatedAt;
}

/**
 * Which organization a user's CONVERSATIONAL turns act on (migration 039). Its own table rather than
 * a column on `user_preferences`, which belongs to the personal-assistant plane; commerce does not
 * write there. A missing row means "not chosen yet" — the command layer asks rather than guessing.
 */
export interface CommerceActiveOrgsTable {
  user_id: string;
  org_id: string;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

/**
 * A member of the public an organization is talking to (migration 040). Unique per ORG, not
 * globally: the same person may be a customer of two clients, and those stay separate records.
 */
export interface CommerceContactsTable {
  id: Generated<string>;
  org_id: string;
  platform: CommercePlatform;
  /** Meta's `wa_id` for WhatsApp — E.164 without the '+'. */
  external_id: string;
  display_name: ColumnType<string | null, string | null | undefined, string | null>;
  phone_e164: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * The client's own fields (migration 044). Read as a parsed object, written as a JSON string —
   * `jsonb` is constrained to an object at the column, so a non-object cannot be stored at all.
   */
  attributes: ColumnType<unknown, string | undefined, string>;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

/**
 * A hand-applied label (migration 044). Unique per org on the LOWERCASED name — two tags differing
 * only in case would split an audience in half and report nothing wrong.
 */
export interface CommerceTagsTable {
  id: Generated<string>;
  org_id: string;
  name: string;
  created_at: CreatedAt;
}

/** Which contacts carry which labels (migration 044). `org_id` denormalized so the tenant filter
 * never needs a join. */
export interface CommerceContactTagsTable {
  contact_id: string;
  tag_id: string;
  org_id: string;
  created_at: CreatedAt;
}

/**
 * A saved audience RULE (migration 044) — never a member list. `definition` is a typed tree parsed
 * and re-validated on every read, so a definition written under an older shape fails loudly when it
 * is next used rather than quietly selecting the wrong people.
 */
export interface CommerceSegmentsTable {
  id: Generated<string>;
  org_id: string;
  name: string;
  description: ColumnType<string | null, string | null | undefined, string | null>;
  definition: ColumnType<unknown, string, string>;
  created_by_user_id: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

/**
 * One thread between an organization and a contact (migration 040). `service_window_expires_at` is
 * load-bearing: outside the 24-hour window Meta accepts a free-form send and never delivers it.
 */
export interface CommerceConversationsTable {
  id: Generated<string>;
  org_id: string;
  channel_account_id: string;
  contact_id: string;
  platform: CommercePlatform;
  last_message_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  service_window_expires_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  created_at: CreatedAt;
}

/**
 * A message in a commerce thread (migration 040). `org_id` is denormalized from the conversation so
 * every tenant filter is a single-table predicate — a scope key that needs a join to apply is a
 * scope key that eventually gets forgotten.
 */
export interface CommerceMessagesTable {
  id: Generated<string>;
  org_id: string;
  conversation_id: string;
  direction: CommerceMessageDirection;
  platform: CommercePlatform;
  provider_message_id: ColumnType<string | null, string | null | undefined, string | null>;
  body: string;
  status: Generated<CommerceMessageStatus>;
  failure_reason: ColumnType<string | null, string | null | undefined, string | null>;
  sent_by_user_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** Which approved template produced this send (migration 046). Null for free-form replies. */
  template_id: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * What Meta CHARGED (migration 046) — reported on the delivery status webhook, never derived here.
   *
   * `billable` is three-valued on purpose: NULL means the webhook has not arrived, FALSE means Meta
   * said the message is free. A two-valued column would bill every in-flight send as free.
   */
  pricing_category: ColumnType<MessagePricingCategory | null, string | null | undefined, string | null>;
  provider_pricing_category: ColumnType<string | null, string | null | undefined, string | null>;
  pricing_model: ColumnType<string | null, string | null | undefined, string | null>;
  billable: ColumnType<boolean | null, boolean | null | undefined, boolean | null>;
  provider_conversation_id: ColumnType<string | null, string | null | undefined, string | null>;
  /**
   * Writable on insert, unlike `CreatedAt` everywhere else. An inbound message is stamped with the
   * timestamp Meta reported — the customer's send time — because a webhook retried hours later would
   * otherwise order the thread by when WE happened to receive it. Omitted on insert it defaults to
   * now(), which is what outbound sends want.
   */
  created_at: ColumnType<Date, Date | undefined, never>;
}

/**
 * A WhatsApp message template (migration 045) — a MIRROR of one that lives at Meta.
 *
 * `status` is this build's closed union and only `approved` may be sent; `provider_status` is Meta's
 * raw word, kept because Meta's vocabulary is Meta's to extend and a status we cannot map must read
 * as "not approved" rather than as the nearest thing we recognize.
 */
export interface CommerceTemplatesTable {
  id: Generated<string>;
  org_id: string;
  channel_account_id: string;
  name: string;
  language: string;
  category: ColumnType<TemplateCategory | null, TemplateCategory | null, TemplateCategory | null>;
  provider_category: ColumnType<string | null, string | null | undefined, string | null>;
  status: Generated<TemplateStatus>;
  provider_status: string;
  provider_template_id: ColumnType<string | null, string | null | undefined, string | null>;
  header_text: ColumnType<string | null, string | null | undefined, string | null>;
  body_text: string;
  footer_text: ColumnType<string | null, string | null | undefined, string | null>;
  /** Derived from `body_text` at write time. Never accepted from a client. */
  variable_count: Generated<number>;
  rejection_reason: ColumnType<string | null, string | null | undefined, string | null>;
  quality_score: ColumnType<string | null, string | null | undefined, string | null>;
  last_synced_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  created_by_user_id: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

/**
 * A scheduled template send to a segment (migration 046).
 *
 * `segment_id` is a reference, not a captured list: the audience is resolved when the dispatch job
 * runs, so a campaign scheduled for Friday reaches Friday's opt-in list rather than Monday's.
 */
export interface CommerceBroadcastsTable {
  id: Generated<string>;
  org_id: string;
  channel_account_id: string;
  name: string;
  segment_id: string;
  template_id: string;
  /** jsonb array of positional strings; length is checked against the template's `variable_count`. */
  variables: ColumnType<unknown, string | undefined, string>;
  status: Generated<BroadcastStatus>;
  scheduled_for: Date;
  started_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  completed_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  total_recipients: Generated<number>;
  sent_count: Generated<number>;
  failed_count: Generated<number>;
  skipped_count: Generated<number>;
  last_error: ColumnType<string | null, string | null | undefined, string | null>;
  created_by_user_id: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

/**
 * One person a broadcast selected (migration 046), including the ones it will never send to.
 *
 * A `skipped` row with its reason is the evidence that the consent gate ran and refused — the thing
 * that turns "1,240 selected, 890 sent" from a discrepancy into an explanation.
 */
export interface CommerceBroadcastRecipientsTable {
  id: Generated<string>;
  org_id: string;
  broadcast_id: string;
  contact_id: string;
  /** Snapshotted from the contact at dispatch — the address actually used on the day. */
  external_id: string;
  display_name: ColumnType<string | null, string | null | undefined, string | null>;
  status: Generated<BroadcastRecipientStatus>;
  reason: ColumnType<string | null, string | null | undefined, string | null>;
  provider_message_id: ColumnType<string | null, string | null | undefined, string | null>;
  message_id: ColumnType<string | null, string | null | undefined, string | null>;
  sent_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  created_at: CreatedAt;
}

/**
 * One immutable entry in a contact's consent history (migration 042). Trigger-enforced append-only —
 * an UPDATE or DELETE raises in the database, not in a repository method someone can forget to call.
 * Opting out inserts a new row; current state is the newest row per `(contact_id, purpose)`.
 */
export interface CommerceContactConsentsTable {
  id: Generated<string>;
  org_id: string;
  contact_id: string;
  platform: CommercePlatform;
  purpose: ConsentPurpose;
  state: ConsentState;
  source: ConsentSource;
  /** The proof, verbatim: a `wamid`, a form URL, an ad id, an import filename. */
  evidence: string;
  recorded_by_user_id: ColumnType<string | null, string | null | undefined, string | null>;
  /** Which opt-in link produced this, when one did (migration 049). NULL for every other source. */
  optin_link_id: ColumnType<string | null, string | null | undefined, string | null>;
  recorded_at: CreatedAt;
}

/**
 * Addresses an organization may not message at all (migration 042). Keyed on `external_id` rather
 * than `contact_id` on purpose: a contact row deleted and re-imported gets a new id, and a block
 * that followed the row would silently lift itself the next time someone uploaded a list.
 */
/**
 * Click-to-WhatsApp opt-in links (migration 049). `token` is globally unique because the inbound path
 * matches it against a message body BEFORE it knows which organization was meant.
 */
export interface CommerceOptinLinksTable {
  id: Generated<string>;
  org_id: string;
  channel_account_id: string;
  name: string;
  /** The number the link opens, as published. Snapshotted at mint time; see the migration. */
  phone_e164: string;
  purpose: ConsentPurpose;
  /** The whole message the customer sends, token included, stored as it will arrive. */
  prefill_text: string;
  token: string;
  status: Generated<OptinLinkStatus>;
  created_by_user_id: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: CreatedAt;
  disabled_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
}

export interface CommerceSuppressionsTable {
  id: Generated<string>;
  org_id: string;
  platform: CommercePlatform;
  external_id: string;
  reason: SuppressionReason;
  detail: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: CreatedAt;
}

/**
 * Per-organization quiet hours and lawful-opt-in attestation (migration 042). A MISSING row is the
 * default state and means no marketing send is permitted — there is no permissive fallback anywhere
 * in this feature, because "no policy found, so we sent it" is the outcome it exists to prevent.
 */
export interface CommerceMessagingPoliciesTable {
  org_id: string;
  /** IANA zone. The organization's declared zone, not the recipient's — see the shared-types model. */
  timezone: string;
  /** Postgres `time`, read back as `HH:MM:SS`. Local wall-clock bounds of the no-send window. */
  quiet_hours_start: string;
  quiet_hours_end: string;
  attested_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  attested_by_user_id: ColumnType<string | null, string | null | undefined, string | null>;
  attestation_text: ColumnType<string | null, string | null | undefined, string | null>;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

/**
 * One unit of durable background work (migration 043).
 *
 * `payload` is `unknown` on read rather than a per-kind union: the queue does not know what its
 * payloads mean, and typing it otherwise would mean the table grows a shape every time a feature
 * does. Each handler narrows its own payload with a zod schema at the moment it claims the job —
 * where a malformed payload becomes that job's `failed`, not the worker's crash.
 */
export interface CommerceJobsTable {
  id: Generated<string>;
  org_id: string;
  kind: CommerceJobKind;
  payload: ColumnType<unknown, string, string>;
  status: Generated<CommerceJobStatus>;
  run_after: ColumnType<Date, Date | undefined, Date>;
  attempts: Generated<number>;
  max_attempts: Generated<number>;
  last_error: ColumnType<string | null, string | null | undefined, string | null>;
  /** The worker's lease. `locked_until` in the past means available, whatever `locked_by` holds. */
  locked_by: ColumnType<string | null, string | null | undefined, string | null>;
  locked_until: ColumnType<Date | null, Date | null | undefined, Date | null>;
  dedupe_key: ColumnType<string | null, string | null | undefined, never>;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, Date | undefined, Date>;
  finished_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
}

/**
 * An uploaded contact list (migration 048).
 *
 * `source_csv` is the file itself. It is never read by a status poll — every select that is not the
 * handler's own naming its columns explicitly is the reason this stays cheap.
 */
export interface CommerceContactImportsTable {
  id: Generated<string>;
  org_id: string;
  created_by_user_id: ColumnType<string | null, string | null | undefined, string | null>;
  filename: string;
  platform: CommercePlatform;
  status: Generated<ContactImportStatus>;
  source_csv: string;
  total_rows: number;
  imported_count: Generated<number>;
  skipped_count: Generated<number>;
  error: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: CreatedAt;
  updated_at: ColumnType<Date, Date | undefined, Date>;
  finished_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
}

/**
 * What became of one row of an import (migration 048). Unique on `(import_id, row_number)`, which is
 * what lets a re-claimed job resume without writing any row's outcome twice.
 */
export interface CommerceContactImportRowsTable {
  id: Generated<string>;
  import_id: string;
  row_number: number;
  raw_phone: string;
  contact_id: ColumnType<string | null, string | null | undefined, string | null>;
  imported: boolean;
  skip_reason: ColumnType<
    ContactImportSkipReason | null,
    ContactImportSkipReason | null | undefined,
    ContactImportSkipReason | null
  >;
  detail: ColumnType<string | null, string | null | undefined, string | null>;
}

/**
 * One operator load of Meta's price sheet for one currency (migration 050).
 *
 * Immutable once written except for the single closing transition (`effective_to` NULL → value),
 * enforced by trigger. `effective_to` NULL means this is the live card for its currency; the
 * partial unique index guarantees there is at most one.
 */
export interface CommerceRateCardsTable {
  id: Generated<string>;
  currency: string;
  effective_from: Date;
  effective_to: ColumnType<Date | null, Date | null | undefined, Date | null>;
  source_note: string;
  loaded_by_user_id: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: CreatedAt;
}

/**
 * One price on a rate card (migration 050): country calling code × pricing category → micros.
 * Fully append-only by trigger; a wrong number is corrected by loading a corrected card.
 *
 * `amount_micros` comes back from pg as a string (bigint); callers convert with BigInt(), never
 * Number() — a price times 40k recipients must not pass through a float.
 */
export interface CommerceMessageRatesTable {
  id: Generated<string>;
  rate_card_id: string;
  country_calling_code: string;
  pricing_category: MessagePricingCategory;
  amount_micros: ColumnType<string, string, never>;
  unit: RateUnit;
}

/**
 * The rating outcome for one delivered message (migration 051). One row per message, written only
 * once a receipt carried pricing; no receipt → no row, so `unpricedMessages` keeps its meaning.
 * `amount_micros`/`rate_amount_micros` come back from pg as strings — convert with BigInt().
 */
export interface CommerceMessageCostsTable {
  id: Generated<string>;
  org_id: string;
  message_id: string;
  state: MessageCostState;
  billable: boolean;
  currency: ColumnType<string | null, string | null | undefined, never>;
  pricing_category: ColumnType<MessagePricingCategory | null, string | null | undefined, never>;
  country_calling_code: ColumnType<string | null, string | null | undefined, never>;
  provider_conversation_id: ColumnType<string | null, string | null | undefined, never>;
  rate_card_id: ColumnType<string | null, string | null | undefined, never>;
  unit: ColumnType<RateUnit | null, RateUnit | null | undefined, never>;
  rate_amount_micros: ColumnType<string | null, string | null | undefined, never>;
  amount_micros: ColumnType<string | null, string | null | undefined, never>;
  priced_at: CreatedAt;
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
  push_tokens: PushTokensTable;
  media_assets: MediaAssetsTable;
  channel_identities: ChannelIdentitiesTable;
  channel_link_codes: ChannelLinkCodesTable;
  channel_inbound_messages: ChannelInboundMessagesTable;
  bridge_consents: BridgeConsentsTable;
  bridge_devices: BridgeDevicesTable;
  whatsapp_chats: WhatsappChatsTable;
  whatsapp_messages: WhatsappMessagesTable;
  whatsapp_outbound: WhatsappOutboundTable;
  runner_devices: RunnerDevicesTable;
  runner_pair_codes: RunnerPairCodesTable;
  runner_sessions: RunnerSessionsTable;
  github_app_installations: GithubAppInstallationsTable;
  // ── Commerce plane (migrations 038–040). Scoped by org_id, never by user_id. ──
  organizations: OrganizationsTable;
  org_members: OrgMembersTable;
  org_invites: OrgInvitesTable;
  channel_accounts: ChannelAccountsTable;
  commerce_inbound_messages: CommerceInboundMessagesTable;
  commerce_active_orgs: CommerceActiveOrgsTable;
  commerce_contacts: CommerceContactsTable;
  commerce_tags: CommerceTagsTable;
  commerce_contact_tags: CommerceContactTagsTable;
  commerce_segments: CommerceSegmentsTable;
  commerce_conversations: CommerceConversationsTable;
  commerce_messages: CommerceMessagesTable;
  commerce_contact_consents: CommerceContactConsentsTable;
  commerce_optin_links: CommerceOptinLinksTable;
  commerce_suppressions: CommerceSuppressionsTable;
  commerce_messaging_policies: CommerceMessagingPoliciesTable;
  commerce_jobs: CommerceJobsTable;
  commerce_templates: CommerceTemplatesTable;
  commerce_broadcasts: CommerceBroadcastsTable;
  commerce_broadcast_recipients: CommerceBroadcastRecipientsTable;
  commerce_contact_imports: CommerceContactImportsTable;
  commerce_contact_import_rows: CommerceContactImportRowsTable;
  // ── Platform-operator data (migration 050): no org_id, gated by requireInstallAdmin, never
  //    readable or writable through any /orgs route. ──
  commerce_rate_cards: CommerceRateCardsTable;
  commerce_message_rates: CommerceMessageRatesTable;
  commerce_message_costs: CommerceMessageCostsTable;
}
