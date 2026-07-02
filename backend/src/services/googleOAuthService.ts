import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { google } from 'googleapis';
import * as Sentry from '@sentry/node';
import { config } from '../config/unifiedConfig';
import type { CalendarEvent } from './calendarFacts';
import type { EmailSummary } from './gmailFacts';
import { classifySentMessage, type SentMailSample } from './sentMailStyleObserver';

/** The OAuth `state` is a short-lived signed token tying the credential-less callback to the user. */
const STATE_TTL = '10m';

/** Read an HTTP status off an unknown error shape without asserting its type. */
function statusOf(error: object): number | undefined {
  if ('response' in error && typeof error.response === 'object' && error.response !== null) {
    const response = error.response;
    if ('status' in response && typeof response.status === 'number') {
      return response.status;
    }
  }
  if ('status' in error && typeof error.status === 'number') {
    return error.status;
  }
  if ('code' in error && typeof error.code === 'number') {
    return error.code;
  }
  return undefined;
}

/** Read the OAuth error string (e.g. 'invalid_grant') off an unknown error shape. */
function oauthErrorOf(error: object): string | undefined {
  if ('response' in error && typeof error.response === 'object' && error.response !== null) {
    const response = error.response;
    if ('data' in response && typeof response.data === 'object' && response.data !== null) {
      const data = response.data;
      if ('error' in data && typeof data.error === 'string') {
        return data.error;
      }
    }
  }
  return undefined;
}

/**
 * True when a Google API error means the grant is gone (token revoked/expired, consent withdrawn) —
 * i.e. the connection can never succeed again without re-consent. Distinguished from transient
 * failures (rate limits, network) so only the former revokes the connection. Covers both the HTTP
 * 401/403 responses from the data APIs and the `invalid_grant` OAuth error on token refresh.
 */
export function isGoogleAuthError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const status = statusOf(error);
  if (status === 401 || status === 403) {
    return true;
  }
  return oauthErrorOf(error) === 'invalid_grant';
}

function oauthClient() {
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri,
  );
}

/** Build the plain-language consent + the Google authorize URL (with a signed state). */
export function buildGoogleConsent(userId: string): {
  consentPrompt: string;
  authorizeUrl: string;
} {
  const state = jwt.sign({ nonce: randomBytes(16).toString('hex') }, config.auth.jwtSecret, {
    subject: userId,
    expiresIn: STATE_TTL,
  });
  const authorizeUrl = oauthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: config.google.scopes,
    state,
  });
  return { consentPrompt: config.google.consentPrompt, authorizeUrl };
}

/** Recover the user id from the signed `state` returned to the callback. Throws if invalid/expired. */
export function verifyCalendarState(state: string): string {
  const payload = jwt.verify(state, config.auth.jwtSecret);
  if (typeof payload === 'string' || typeof payload.sub !== 'string') {
    throw new Error('invalid OAuth state');
  }
  return payload.sub;
}

/** Exchange an authorization code for a long-lived refresh token (stored in the vault by the caller). */
export async function exchangeCodeForRefreshToken(code: string): Promise<string> {
  const { tokens } = await oauthClient().getToken(code);
  if (!tokens.refresh_token) {
    throw new Error('Google did not return a refresh token; re-consent is required');
  }
  return tokens.refresh_token;
}

/**
 * Fetch the next-7-days events server-side using a vaulted refresh token, minimized to
 * `CalendarEvent`. The raw Google payload (attendees, locations, descriptions) is dropped here and
 * NEVER leaves this function — only derived facts cross the broker to the agent.
 */
export async function fetchUpcomingEvents(refreshToken: string): Promise<CalendarEvent[]> {
  const client = oauthClient();
  client.setCredentials({ refresh_token: refreshToken });
  const calendar = google.calendar({ version: 'v3', auth: client });

  const now = new Date();
  const timeMax = new Date(now.getTime() + config.calendar.lookaheadDays * 24 * 60 * 60 * 1000);

  const response = await calendar.events.list({
    calendarId: 'primary',
    timeMin: now.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: config.google.maxEvents,
  });

  const items = response.data.items ?? [];
  const events: CalendarEvent[] = [];
  for (const item of items) {
    const start = item.start?.dateTime;
    const end = item.end?.dateTime;
    // Only timed events carry the start/end we reason over; skip all-day entries.
    if (typeof start === 'string' && typeof end === 'string') {
      events.push({ start, end, title: item.summary ?? '(untitled)' });
    }
  }
  return events;
}

/** Read a header value (case-insensitive) from a Gmail metadata payload. */
function headerValue(
  headers: ReadonlyArray<{ name?: string | null; value?: string | null }>,
  name: string,
): string {
  const match = headers.find((h) => (h.name ?? '').toLowerCase() === name.toLowerCase());
  return match?.value ?? '';
}

/**
 * Fetch the recent emails (within `lookbackDays`) server-side using a vaulted refresh token,
 * minimized to `EmailSummary` (subject + sender + unread + date only). The window is the user's
 * stored preference, resolved by the control plane — never hardcoded here. Bodies, recipients, and
 * attachments are never read here and NEVER leave this function — only derived facts cross the broker.
 */
export async function fetchRecentEmails(
  refreshToken: string,
  lookbackDays: number,
): Promise<EmailSummary[]> {
  const client = oauthClient();
  client.setCredentials({ refresh_token: refreshToken });
  const gmail = google.gmail({ version: 'v1', auth: client });

  const list = await gmail.users.messages.list({
    userId: 'me',
    q: `newer_than:${lookbackDays}d`,
    maxResults: config.google.maxEmails,
  });

  const messages = list.data.messages ?? [];
  const emails: EmailSummary[] = [];
  for (const ref of messages) {
    if (!ref.id) {
      continue;
    }
    const message = await gmail.users.messages.get({
      userId: 'me',
      id: ref.id,
      format: 'metadata',
      metadataHeaders: ['Subject', 'From', 'Date'],
    });
    const headers = message.data.payload?.headers ?? [];
    const labelIds = message.data.labelIds ?? [];
    emails.push({
      subject: headerValue(headers, 'Subject'),
      from: headerValue(headers, 'From'),
      unread: labelIds.includes('UNREAD'),
      date: headerValue(headers, 'Date'),
    });
  }
  return emails;
}

/** Extract the bare email addresses from a raw recipient header ("A <a@x.com>, b@y.com" → both). */
function parseAddresses(header: string): string[] {
  if (header.trim().length === 0) {
    return [];
  }
  const addresses: string[] = [];
  for (const part of header.split(',')) {
    // A header entry is either "Display Name <addr>" or a bare "addr"; take the angle-bracketed
    // address when present, else the trimmed token. Lowercased so recurrence counts case-insensitively.
    const angle = part.match(/<([^>]+)>/);
    const addr = (angle?.[1] ?? part).trim().toLowerCase();
    if (addr.length > 0) {
      addresses.push(addr);
    }
  }
  return addresses;
}

/** The domain of an email address ("a@x.com" → "x.com"); empty when it has no "@". */
function emailDomain(address: string): string {
  const at = address.lastIndexOf('@');
  return at >= 0 ? address.slice(at + 1) : '';
}

/**
 * The single most-frequently-CC'd contact across a Sent-mail sample — a concrete address plus how
 * often it recurred and whether it's on the user's own domain. The concrete `address` exists ONLY so
 * the control plane can role-abstract or vault it; it is never surfaced to the observer or the model.
 */
export interface RecurringCcContact {
  readonly address: string;
  readonly count: number;
  readonly sameDomain: boolean;
}

/** The minimized result of sampling Sent mail: per-message style features + the recurring CC contact. */
export interface SentMailObservation {
  readonly samples: SentMailSample[];
  readonly recurringCc: RecurringCcContact | null;
}

/**
 * Fetch a bounded sample of the user's OWN Sent mail and reduce it to the minimized signals the opt-in
 * style observer needs. Mirrors `fetchRecentEmails` but queries `in:sent` and reads only the CC header
 * + the body PREFIX (`snippet`). The snippet is classified to a salutation enum + warmth flag INSIDE
 * this function (`classifySentMessage`) and discarded; CC addresses are aggregated HERE to find the
 * single most-recurring contact, and only that one contact's address (for vaulting) leaves. No body,
 * subject, or the full recipient graph is ever returned, stored, or sent to the model. `accountEmail`
 * is the connected account's own address, used only to decide whether the recurring contact is
 * internal (same domain). Only the sampling caller (gated by the user's explicit opt-in) invokes this.
 */
export async function fetchSentMailSamples(
  refreshToken: string,
  lookbackDays: number,
  maxSamples: number,
  accountEmail: string,
): Promise<SentMailObservation> {
  const client = oauthClient();
  client.setCredentials({ refresh_token: refreshToken });
  const gmail = google.gmail({ version: 'v1', auth: client });

  const list = await gmail.users.messages.list({
    userId: 'me',
    q: `in:sent newer_than:${lookbackDays}d`,
    maxResults: maxSamples,
  });

  const messages = list.data.messages ?? [];
  const samples: SentMailSample[] = [];
  const ccCounts = new Map<string, number>();
  for (const ref of messages) {
    if (!ref.id) {
      continue;
    }
    const message = await gmail.users.messages.get({
      userId: 'me',
      id: ref.id,
      format: 'metadata',
      metadataHeaders: ['Cc'],
    });
    const headers = message.data.payload?.headers ?? [];
    const snippet = message.data.snippet ?? '';
    const ccAddresses = parseAddresses(headerValue(headers, 'Cc'));
    samples.push(classifySentMessage({ snippet, ccCount: ccAddresses.length }));
    // Count DISTINCT CC addresses per message so one email CC'ing a contact twice can't inflate it.
    for (const addr of new Set(ccAddresses)) {
      ccCounts.set(addr, (ccCounts.get(addr) ?? 0) + 1);
    }
  }

  return { samples, recurringCc: topRecurringCc(ccCounts, accountEmail) };
}

/** Pick the most-recurring CC address and describe it (count + same-domain); null when none seen. */
function topRecurringCc(
  ccCounts: ReadonlyMap<string, number>,
  accountEmail: string,
): RecurringCcContact | null {
  let top: RecurringCcContact | null = null;
  const ownDomain = emailDomain(accountEmail.trim().toLowerCase());
  for (const [address, count] of ccCounts) {
    if (!top || count > top.count) {
      top = { address, count, sameDomain: ownDomain.length > 0 && emailDomain(address) === ownDomain };
    }
  }
  return top;
}

/** The connected Google account's email address — used to label the connection (multi-account). */
export async function fetchAccountEmail(refreshToken: string): Promise<string> {
  const client = oauthClient();
  client.setCredentials({ refresh_token: refreshToken });
  const gmail = google.gmail({ version: 'v1', auth: client });
  const profile = await gmail.users.getProfile({ userId: 'me' });
  return profile.data.emailAddress ?? '';
}

/**
 * Revoke a refresh token at Google so a disconnect fully severs access — not just locally. Google
 * invalidates the token (and its access tokens) on their side. Best-effort: an already-invalid or
 * unreachable token still lets the caller proceed with the local revoke, so we swallow-and-report
 * rather than throw. Returns whether Google acknowledged the revocation.
 */
export async function revokeRefreshToken(refreshToken: string): Promise<boolean> {
  try {
    await oauthClient().revokeToken(refreshToken);
    return true;
  } catch (error) {
    // A token Google already considers dead is a successful outcome for us — the grant is gone.
    if (isGoogleAuthError(error)) {
      return true;
    }
    Sentry.captureException(error);
    return false;
  }
}
