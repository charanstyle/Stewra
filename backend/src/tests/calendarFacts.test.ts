import { extractCalendarFacts, type CalendarEvent } from '../services/calendarFacts.js';

/** Pure unit tests — no DB, no network. Fixtures in, derived fact strings out. */

// A fixed "now" so the free-evening lookahead window is deterministic. Monday 2025-06-30, 09:00.
const NOW = new Date(2025, 5, 30, 9, 0, 0);

function ev(start: string, end: string, title: string): CalendarEvent {
  return { start, end, title };
}

describe('extractCalendarFacts', () => {
  it('flags overlapping events as a conflict', () => {
    const facts = extractCalendarFacts(
      [
        ev('2025-06-30T10:00:00', '2025-06-30T11:00:00', 'Standup'),
        ev('2025-06-30T10:30:00', '2025-06-30T11:30:00', 'Client call'),
      ],
      NOW,
    );
    expect(facts.some((f) => f.includes('overlap'))).toBe(true);
    expect(facts.some((f) => f.includes('Standup') && f.includes('Client call'))).toBe(true);
  });

  it('flags a packed day (>= 4 events)', () => {
    const facts = extractCalendarFacts(
      [
        ev('2025-07-01T09:00:00', '2025-07-01T09:30:00', 'A'),
        ev('2025-07-01T10:00:00', '2025-07-01T10:30:00', 'B'),
        ev('2025-07-01T11:00:00', '2025-07-01T11:30:00', 'C'),
        ev('2025-07-01T12:00:00', '2025-07-01T12:30:00', 'D'),
      ],
      NOW,
    );
    expect(facts.some((f) => f.includes('packed with 4 events'))).toBe(true);
  });

  it('surfaces the single free evening when every other evening is busy', () => {
    // Fill evenings for the next 7 days EXCEPT one, so exactly one free evening remains.
    const events: CalendarEvent[] = [];
    for (let offset = 0; offset < 7; offset += 1) {
      if (offset === 3) {
        continue; // leave this evening free
      }
      const d = new Date(2025, 5, 30 + offset, 19, 0, 0);
      const end = new Date(2025, 5, 30 + offset, 20, 0, 0);
      events.push(ev(d.toISOString(), end.toISOString(), `Evening ${offset}`));
    }
    const facts = extractCalendarFacts(events, NOW);
    expect(facts.some((f) => f.includes('only free evening this week'))).toBe(true);
  });

  it('returns no facts for an empty calendar', () => {
    expect(extractCalendarFacts([], NOW)).toEqual([]);
  });
});
