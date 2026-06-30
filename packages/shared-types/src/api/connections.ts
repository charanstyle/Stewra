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

/** Returned after a connection is created or its status changes. */
export interface ConnectionResponse {
  readonly connection: Connection;
}

/** All of a user's connections (active and revoked), for the trust/control surfaces. */
export interface ListConnectionsResponse {
  readonly connections: ReadonlyArray<Connection>;
}
