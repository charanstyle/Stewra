import type { ColumnType, Generated } from 'kysely';
import type { AuditAction, AuditResourceType, UserRole } from '@stewra/shared-types';

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
  created_at: CreatedAt;
}

export interface UserPreferencesTable {
  user_id: string;
  gmail_lookback_days: number;
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

export interface Database {
  users: UsersTable;
  audit_log: AuditLogTable;
  connections: ConnectionsTable;
  user_preferences: UserPreferencesTable;
  migrations: MigrationsTable;
  vault_secrets: VaultSecretsTable;
  email_verification_codes: EmailVerificationCodesTable;
}
