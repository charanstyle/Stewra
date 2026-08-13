import type { Connection } from '../models/connection';

/**
 * Step 1 of connecting a calendar: the backend returns a PLAIN-LANGUAGE consent prompt (never a raw
 * OAuth scope list — build-plan principle 6) and the Google authorize URL the browser navigates to.
 */
export interface StartCalendarConnectionResponse {
  /** One plain sentence the user approves, e.g. "Allow Stewra to read your calendar?". */
  readonly consentPrompt: string;
  /** The Google OAuth authorize URL to redirect the browser to once the user says yes. */
  readonly authorizeUrl: string;
}

/**
 * Step 1 of connecting a bank (the money milestone): the backend returns the plain-language consent
 * prompt and a short-lived Plaid Link token. The client opens Plaid Link with the token; the bank
 * consent itself happens inside Link, never on our pages.
 */
export interface StartMoneyConnectionResponse {
  /** One plain sentence the user approves before Link opens. */
  readonly consentPrompt: string;
  /** The short-lived token that opens Plaid Link on the client. */
  readonly linkToken: string;
}

/**
 * Step 2: Link hands the client a one-time `public_token`; the client posts it here and the server
 * exchanges it for the long-lived access token — which goes straight into the vault and never
 * appears in any response.
 */
export interface ExchangeMoneyPublicTokenRequest {
  readonly publicToken: string;
}

/** Returned after a connection is created or its status changes. */
export interface ConnectionResponse {
  readonly connection: Connection;
}

/** All of a user's connections (active and revoked), for the trust/control surfaces. */
export interface ListConnectionsResponse {
  readonly connections: ReadonlyArray<Connection>;
}
