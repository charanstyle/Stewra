import { describe, expect, it } from 'vitest';
import { ChatDirectory } from '../core/chatDirectory.js';

/**
 * ChatDirectory is a pure accumulator — no I/O, no doubles needed. These tests pin the behaviours
 * the picker depends on: individual-chats-only at the door, names that never regress, recency
 * ordering, and a serialize/hydrate round-trip that discards garbage rather than half-recovering it.
 */
describe('ChatDirectory', () => {
  it('admits 1:1 chats (s.whatsapp.net and lid) and rejects groups, broadcast, newsletter, and status', () => {
    const directory = new ChatDirectory();
    directory.applyChats([
      { id: '15551234567@s.whatsapp.net', name: 'Ana', timestampSeconds: 100 },
      { id: '987654321@lid', name: 'Lid Friend', timestampSeconds: 90 },
      { id: '123-456@g.us', name: 'Family Group', timestampSeconds: 999 },
      { id: 'broadcastlist@broadcast', name: 'My Broadcast', timestampSeconds: 999 },
      { id: 'channel@newsletter', name: 'Some Channel', timestampSeconds: 999 },
      { id: 'status@broadcast', name: 'Status', timestampSeconds: 999 },
    ]);

    expect(directory.list().map((chat) => chat.jid)).toEqual([
      '15551234567@s.whatsapp.net',
      '987654321@lid',
    ]);
  });

  it('normalises JIDs: device suffixes collapse and c.us maps onto s.whatsapp.net as one chat', () => {
    const directory = new ChatDirectory();
    directory.applyChats([{ id: '15551234567:12@s.whatsapp.net', name: 'Ana', timestampSeconds: 100 }]);
    directory.applyChats([{ id: '15551234567@c.us', name: null, timestampSeconds: 200 }]);

    const listed = directory.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual({
      jid: '15551234567@s.whatsapp.net',
      displayName: 'Ana',
      lastActivity: 200_000,
    });
  });

  it('never regresses a known name to null or blank, but lets a newer real name win', () => {
    const directory = new ChatDirectory();
    directory.applyContacts([{ id: '1@s.whatsapp.net', name: 'Ana' }]);
    // A nameless chat event (e.g. chats.update with only a timestamp) must not erase the name.
    directory.applyChats([{ id: '1@s.whatsapp.net', name: null, timestampSeconds: 50 }]);
    directory.applyChats([{ id: '1@s.whatsapp.net', name: '   ', timestampSeconds: 60 }]);
    expect(directory.list()[0]?.displayName).toBe('Ana');

    // contacts.update rename propagates (and incidental whitespace is trimmed).
    directory.applyContacts([{ id: '1@s.whatsapp.net', name: '  Ana Maria  ' }]);
    expect(directory.list()[0]?.displayName).toBe('Ana Maria');
  });

  it('falls back to the bare number for a chat nothing has named', () => {
    const directory = new ChatDirectory();
    directory.applyChats([{ id: '15551234567@s.whatsapp.net', timestampSeconds: 10 }]);
    expect(directory.list()[0]?.displayName).toBe('15551234567');
  });

  it('lists by recency, keeps the max-seen activity, and treats contacts as names-only (no activity)', () => {
    const directory = new ChatDirectory();
    directory.applyChats([
      { id: 'old@s.whatsapp.net', name: 'Old', timestampSeconds: 100 },
      { id: 'new@s.whatsapp.net', name: 'New', timestampSeconds: 300 },
    ]);
    // An out-of-order older event must not pull a chat's activity backwards.
    directory.applyChats([{ id: 'new@s.whatsapp.net', name: null, timestampSeconds: 200 }]);
    // A contact alone is not activity — it must sort below chats that have actually spoken.
    directory.applyContacts([{ id: 'silent@s.whatsapp.net', name: 'Silent' }]);

    expect(directory.list()).toEqual([
      { jid: 'new@s.whatsapp.net', displayName: 'New', lastActivity: 300_000 },
      { jid: 'old@s.whatsapp.net', displayName: 'Old', lastActivity: 100_000 },
      { jid: 'silent@s.whatsapp.net', displayName: 'Silent', lastActivity: 0 },
    ]);
  });

  it('noteMessage records a live message as activity, named by pushName', () => {
    const directory = new ChatDirectory();
    directory.noteMessage('2@s.whatsapp.net', 'Bea', new Date(1_700_000_000_000));

    expect(directory.list()).toEqual([
      { jid: '2@s.whatsapp.net', displayName: 'Bea', lastActivity: 1_700_000_000_000 },
    ]);

    // A later message without a pushName keeps the name and advances the clock.
    directory.noteMessage('2@s.whatsapp.net', null, new Date(1_700_000_050_000));
    expect(directory.list()[0]).toEqual({
      jid: '2@s.whatsapp.net',
      displayName: 'Bea',
      lastActivity: 1_700_000_050_000,
    });
  });

  it('round-trips through serialize/hydrate', () => {
    const directory = new ChatDirectory();
    directory.applyChats([
      { id: '1@s.whatsapp.net', name: 'Ana', timestampSeconds: 100 },
      { id: '2@s.whatsapp.net', timestampSeconds: 200 },
    ]);

    const restored = new ChatDirectory();
    restored.hydrate(directory.serialize());
    expect(restored.list()).toEqual(directory.list());
  });

  it('hydrate discards garbage wholesale and skips malformed entries, keeping the valid ones', () => {
    const notJson = new ChatDirectory();
    notJson.hydrate('this is not json');
    expect(notJson.list()).toEqual([]);

    const notArray = new ChatDirectory();
    notArray.hydrate('{"jid":"1@s.whatsapp.net"}');
    expect(notArray.list()).toEqual([]);

    const mixed = new ChatDirectory();
    mixed.hydrate(
      JSON.stringify([
        null,
        'string-entry',
        { name: 'no jid' },
        { jid: 42, name: 'numeric jid' },
        { jid: 'group@g.us', name: 'smuggled group', lastActivity: 999_000 },
        { jid: '1@s.whatsapp.net', name: 'Ana', lastActivity: 100_000 },
        { jid: '2@s.whatsapp.net', name: null, lastActivity: 'soon' },
      ]),
    );
    expect(mixed.list()).toEqual([
      { jid: '1@s.whatsapp.net', displayName: 'Ana', lastActivity: 100_000 },
      { jid: '2@s.whatsapp.net', displayName: '2', lastActivity: 0 },
    ]);
  });
});
