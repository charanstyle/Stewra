import type { ISODateString, UUID } from '../common/base';

/**
 * The sources Stewra can connect to (read-only). One `google` connection grants read-only Calendar
 * and Gmail for a single Google account; a user may connect several Google accounts. `aggregator`
 * (money) ships in a later milestone. No gray-market providers — only sanctioned, revocable
 * connections (build-plan principle 7).
 */
export type ConnectionProvider = 'google' | 'aggregator';

/** A connection is `active` until the user (or a failure) revokes it. */
export type ConnectionStatus = 'active' | 'revoked';

/**
 * Public-facing connection shape. It deliberately NEVER includes the vault reference or any token —
 * the credential lives only in the vault, server-side, and never reaches the client or the agent.
 * `accountEmail` labels which connected account this is (e.g. which of several Gmail addresses).
 */
export interface Connection {
  readonly id: UUID;
  readonly provider: ConnectionProvider;
  /** The connected account's email (Google address); empty for providers without one. */
  readonly accountEmail: string;
  readonly status: ConnectionStatus;
  readonly createdAt: ISODateString;
}
