import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { google, type gmail_v1 } from 'googleapis';
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

/**
 * Exchange an authorization code for a long-lived refresh token (stored in the vault by the caller)
 * plus the scopes Google actually granted. The granted set (from `tokens.scope`, space-separated) is
 * persisted on the connection so the backend can tell a full grant from a read-only one and prompt
 * for re-consent when the write scopes are missing. The token itself is returned only to the caller,
 * which vaults it — it is never logged.
 */
export async function exchangeCodeForRefreshToken(
  code: string,
): Promise<{ refreshToken: string; scopes: string[] }> {
  const { tokens } = await oauthClient().getToken(code);
  if (!tokens.refresh_token) {
    throw new Error('Google did not return a refresh token; re-consent is required');
  }
  const scopes = (tokens.scope ?? '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return { refreshToken: tokens.refresh_token, scopes };
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
      important: labelIds.includes('IMPORTANT'),
      starred: labelIds.includes('STARRED'),
      date: headerValue(headers, 'Date'),
    });
  }
  return emails;
}

/**
 * A gmail v1 API client bound to a vaulted refresh token. Built once by the sync engine and reused
 * across many message reads so a single token refresh serves the whole pass.
 */
export type GmailClient = ReturnType<typeof google.gmail>;

export function gmailClient(refreshToken: string): GmailClient {
  const client = oauthClient();
  client.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: 'v1', auth: client });
}

/** A full message pulled for the encrypted store. Unlike the minimized-facts path, this DOES carry
 * the body — it is persisted (encrypted) in the control plane and never crosses to the agent. */
export interface FetchedMessage {
  readonly gmailMessageId: string;
  readonly gmailThreadId: string;
  readonly gmailHistoryId: string | null;
  readonly fromAddress: string;
  readonly fromName: string;
  readonly sentAt: Date | null;
  readonly subject: string;
  readonly snippet: string;
  readonly body: string;
  readonly labelIds: ReadonlyArray<string>;
}

/** One page of message ids from a Gmail search. */
export async function listMessageIds(
  gmail: GmailClient,
  query: string,
  pageSize: number,
  pageToken?: string,
): Promise<{ ids: string[]; nextPageToken: string | null }> {
  const list = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: pageSize,
    ...(pageToken ? { pageToken } : {}),
  });
  const ids = (list.data.messages ?? []).map((m) => m.id).filter((id): id is string => !!id);
  return { ids, nextPageToken: list.data.nextPageToken ?? null };
}

/** Decode a base64url Gmail body part to UTF-8 text. */
function decodeBody(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8');
}

/** Recursively pull the best plaintext out of a Gmail MIME payload (prefers text/plain). */
function extractPlainBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (payload === undefined) {
    return '';
  }
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBody(payload.body.data);
  }
  if (payload.parts) {
    // Prefer a text/plain part; fall back to whatever text the nested parts yield.
    for (const part of payload.parts) {
      const text = extractPlainBody(part);
      if (text.length > 0) {
        return text;
      }
    }
  }
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    // Strip tags as a last resort so an HTML-only mail still yields readable text.
    return decodeBody(payload.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return '';
}

/** Fetch and normalize one full message for the store. */
export async function getFullMessage(gmail: GmailClient, id: string): Promise<FetchedMessage> {
  const message = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
  const data = message.data;
  const headers = data.payload?.headers ?? [];
  const fromHeader = headerValue(headers, 'From');
  const fromMatch = fromHeader.match(/<([^>]+)>/);
  const fromAddress = (fromMatch?.[1] ?? fromHeader).trim().toLowerCase();
  const fromName = fromMatch ? fromHeader.slice(0, fromHeader.indexOf('<')).trim() : '';
  const internalDate = data.internalDate ? Number(data.internalDate) : NaN;
  return {
    gmailMessageId: data.id ?? id,
    gmailThreadId: data.threadId ?? '',
    gmailHistoryId: data.historyId ?? null,
    fromAddress,
    fromName: fromName.replace(/^"|"$/g, ''),
    sentAt: Number.isFinite(internalDate) ? new Date(internalDate) : null,
    subject: headerValue(headers, 'Subject'),
    snippet: data.snippet ?? '',
    body: extractPlainBody(data.payload ?? undefined),
    labelIds: data.labelIds ?? [],
  };
}

/** Ids of messages added since `startHistoryId`, plus the newest historyId. `expired` is true when the
 * cursor is too old (Gmail 404s) — the caller falls back to a bounded re-list. */
export async function listHistory(
  gmail: GmailClient,
  startHistoryId: string,
): Promise<{ messageIds: string[]; lastHistoryId: string | null; expired: boolean }> {
  try {
    const ids = new Set<string>();
    let pageToken: string | undefined;
    let lastHistoryId: string | null = startHistoryId;
    do {
      const res = await gmail.users.history.list({
        userId: 'me',
        startHistoryId,
        historyTypes: ['messageAdded'],
        ...(pageToken ? { pageToken } : {}),
      });
      for (const h of res.data.history ?? []) {
        for (const added of h.messagesAdded ?? []) {
          if (added.message?.id) {
            ids.add(added.message.id);
          }
        }
      }
      lastHistoryId = res.data.historyId ?? lastHistoryId;
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return { messageIds: [...ids], lastHistoryId, expired: false };
  } catch (error) {
    if (typeof error === 'object' && error !== null && statusOf(error) === 404) {
      return { messageIds: [], lastHistoryId: null, expired: true };
    }
    throw error;
  }
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
      metadataHeaders: ['Cc', 'Date'],
    });
    const headers = message.data.payload?.headers ?? [];
    const snippet = message.data.snippet ?? '';
    const ccAddresses = parseAddresses(headerValue(headers, 'Cc'));
    // The Date header is reduced to a coarse send-time band INSIDE classifySentMessage and discarded —
    // the exact timestamp never leaves this function, exactly like the snippet text.
    samples.push(
      classifySentMessage({
        snippet,
        ccCount: ccAddresses.length,
        dateHeader: headerValue(headers, 'Date'),
      }),
    );
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
