import { randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { google } from 'googleapis';
import { config } from '../config/unifiedConfig';
import type { CalendarEvent } from './calendarFacts';
import type { EmailSummary } from './gmailFacts';

/** Read-only scopes — the narrowest scopes that let us advise. Never write/send access. */
const READONLY_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
];
/** Plain-language consent shown to the user — NOT a raw scope list (build-plan principle 6). */
const CONSENT_PROMPT =
  'Allow Stewra to read your Google Calendar and Gmail? It only reads — to spot conflicts, bills, ' +
  'and things worth your attention. It never sends, replies, deletes, or changes anything.';
/** The OAuth `state` is a short-lived signed token tying the credential-less callback to the user. */
const STATE_TTL = '10m';
const LOOKAHEAD_DAYS = 7;
const MAX_EVENTS = 50;
const MAX_EMAILS = 20;

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
    scope: READONLY_SCOPES,
    state,
  });
  return { consentPrompt: CONSENT_PROMPT, authorizeUrl };
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
  const timeMax = new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);

  const response = await calendar.events.list({
    calendarId: 'primary',
    timeMin: now.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: MAX_EVENTS,
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
    maxResults: MAX_EMAILS,
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

/** The connected Google account's email address — used to label the connection (multi-account). */
export async function fetchAccountEmail(refreshToken: string): Promise<string> {
  const client = oauthClient();
  client.setCredentials({ refresh_token: refreshToken });
  const gmail = google.gmail({ version: 'v1', auth: client });
  const profile = await gmail.users.getProfile({ userId: 'me' });
  return profile.data.emailAddress ?? '';
}

export const GOOGLE_CONSENT_PROMPT = CONSENT_PROMPT;
