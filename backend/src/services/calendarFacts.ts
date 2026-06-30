/**
 * Pure, deterministic extraction of DERIVED FACTS from calendar events. This is the only thing the
 * broker is allowed to surface to the agent — short, human-meaningful strings, never raw events.
 * Keeping it pure (events + `now` in, fact strings out) makes it unit-testable with no network.
 */

/** A minimized calendar event — already stripped of attendees, locations, notes, etc. */
export interface CalendarEvent {
  /** ISO start timestamp. */
  readonly start: string;
  /** ISO end timestamp. */
  readonly end: string;
  /** A short, non-sensitive title. */
  readonly title: string;
}

interface ParsedEvent {
  readonly start: Date;
  readonly end: Date;
  readonly title: string;
}

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

const EVENING_START_HOUR = 18;
const EVENING_END_HOUR = 22;
const BUSY_DAY_THRESHOLD = 4;
const LOOKAHEAD_DAYS = 7;

function dayName(date: Date): string {
  return DAY_NAMES[date.getDay()] ?? 'that day';
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function parseEvents(events: ReadonlyArray<CalendarEvent>): ParsedEvent[] {
  return events
    .map((e) => ({ start: new Date(e.start), end: new Date(e.end), title: e.title }))
    .filter((e) => !Number.isNaN(e.start.getTime()) && !Number.isNaN(e.end.getTime()))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** Overlapping events the user may have double-booked. */
function conflictFacts(events: ReadonlyArray<ParsedEvent>): string[] {
  const facts: string[] = [];
  for (let i = 0; i < events.length; i += 1) {
    for (let j = i + 1; j < events.length; j += 1) {
      const a = events[i];
      const b = events[j];
      if (a === undefined || b === undefined) {
        continue;
      }
      // Sorted by start, so a.start <= b.start; they overlap iff b starts before a ends.
      if (b.start.getTime() < a.end.getTime()) {
        facts.push(`"${a.title}" and "${b.title}" overlap on ${dayName(a.start)}`);
      }
    }
  }
  return facts;
}

/** Days carrying more than the user can comfortably hold. */
function overcommitmentFacts(events: ReadonlyArray<ParsedEvent>): string[] {
  const countByDay = new Map<string, { count: number; date: Date }>();
  for (const e of events) {
    const key = dayKey(e.start);
    const entry = countByDay.get(key);
    if (entry) {
      entry.count += 1;
    } else {
      countByDay.set(key, { count: 1, date: e.start });
    }
  }
  const facts: string[] = [];
  for (const { count, date } of countByDay.values()) {
    if (count >= BUSY_DAY_THRESHOLD) {
      facts.push(`${dayName(date)} is packed with ${count} events`);
    }
  }
  return facts;
}

/** The high-signal "this is your only free evening" insight. */
function freeEveningFacts(events: ReadonlyArray<ParsedEvent>, now: Date): string[] {
  const freeEvenings: Date[] = [];
  for (let offset = 0; offset < LOOKAHEAD_DAYS; offset += 1) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    const eveningStart = new Date(day);
    eveningStart.setHours(EVENING_START_HOUR, 0, 0, 0);
    const eveningEnd = new Date(day);
    eveningEnd.setHours(EVENING_END_HOUR, 0, 0, 0);
    if (eveningEnd.getTime() <= now.getTime()) {
      continue; // evening already passed
    }
    const busy = events.some(
      (e) => e.start.getTime() < eveningEnd.getTime() && e.end.getTime() > eveningStart.getTime(),
    );
    if (!busy) {
      freeEvenings.push(eveningStart);
    }
  }
  if (freeEvenings.length === 1) {
    const evening = freeEvenings[0];
    if (evening !== undefined) {
      return [`${dayName(evening)} evening is your only free evening this week`];
    }
  }
  return [];
}

export function extractCalendarFacts(
  events: ReadonlyArray<CalendarEvent>,
  now: Date,
): string[] {
  const parsed = parseEvents(events);
  return [
    ...conflictFacts(parsed),
    ...overcommitmentFacts(parsed),
    ...freeEveningFacts(parsed, now),
  ];
}
