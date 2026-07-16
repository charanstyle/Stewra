import { describe, expect, it, vi } from 'vitest';
import { AllowlistGate, normalizeJid } from '../core/allowlist.js';

const OWN = '447700900123@s.whatsapp.net';
const OWN_LID = '100000000000001@lid';
const SARAH = '447700900999@s.whatsapp.net';
const STRANGER = '447700900777@s.whatsapp.net';

const gateWith = (
  ticked: Array<{ jid: string; displayName: string }> = [],
  ownLid?: string,
): AllowlistGate => {
  const gate = new AllowlistGate(OWN, ownLid);
  gate.setAllowed(ticked.map((c) => ({ ...c, isSelfChat: false })));
  return gate;
};

describe('normalizeJid', () => {
  it('collapses the several spellings WhatsApp uses for the same person', () => {
    // If these did not collapse, a ticked chat would silently fail to match — and a filter that silently
    // fails to match is a filter that leaks.
    expect(normalizeJid('447700900999:12@s.whatsapp.net')).toBe(SARAH);
    expect(normalizeJid('447700900999@c.us')).toBe(SARAH);
    expect(normalizeJid(SARAH)).toBe(SARAH);
  });
});

/**
 * THE PROMISE: "Stewra's servers never learn a chat exists unless you tick it."
 *
 * These tests are what make that checkable rather than merely stated. The gate is pure — it holds no
 * socket and no fetch — so a dropped message cannot become a network call even by accident.
 */
describe('the allowlist gate', () => {
  it('always forwards the self-chat — that IS the product', () => {
    expect(gateWith().decide({ remoteJid: OWN, fromMe: true })).toEqual({
      forward: true,
      isSelfChat: true,
      jid: OWN,
    });
  });

  it('still recognises the self-chat when WhatsApp adds a device suffix', () => {
    expect(gateWith().decide({ remoteJid: '447700900123:47@s.whatsapp.net', fromMe: true })).toEqual({
      forward: true,
      isSelfChat: true,
      jid: OWN,
    });
  });

  it('recognises the self-chat when it arrives as a LID, and forwards it under the phone JID', () => {
    // The real bug: WhatsApp addressed "Message yourself" by LID, the gate did not know the LID, and the
    // message was dropped as "not_allowed" so Stewra never answered. It must match — AND canonicalise to
    // the phone JID, because the server's lookup, dedupe, and echo-suppression all key on that one address.
    const gate = gateWith([], OWN_LID);
    expect(gate.decide({ remoteJid: OWN_LID, fromMe: true })).toEqual({
      forward: true,
      isSelfChat: true,
      jid: OWN,
    });
    // Even with a device suffix on the LID.
    expect(gate.decide({ remoteJid: '100000000000001:12@lid', fromMe: true })).toEqual({
      forward: true,
      isSelfChat: true,
      jid: OWN,
    });
  });

  it('does NOT treat a LID as the self-chat when no own-LID was supplied', () => {
    // Without the LID, an unknown @lid address is just an unticked chat — dropped, never leaked.
    expect(gateWith().decide({ remoteJid: OWN_LID, fromMe: true })).toEqual({
      forward: false,
      reason: 'not_allowed',
    });
  });

  it('DROPS a chat the user never ticked — it never leaves their computer', () => {
    expect(gateWith().decide({ remoteJid: STRANGER, fromMe: false })).toEqual({
      forward: false,
      reason: 'not_allowed',
    });
  });

  it('forwards a ticked chat, but only what the OTHER person said', () => {
    const gate = gateWith([{ jid: SARAH, displayName: 'Sarah' }]);

    expect(gate.decide({ remoteJid: SARAH, fromMe: false })).toEqual({
      forward: true,
      isSelfChat: false,
      jid: SARAH,
    });
    // The user's own half of the conversation. Stewra was asked to read what Sarah says, not to keep a
    // copy of everything the user says to her.
    expect(gate.decide({ remoteJid: SARAH, fromMe: true })).toEqual({
      forward: false,
      reason: 'not_from_user',
    });
  });

  it('stops forwarding the moment a chat is unticked', () => {
    const gate = gateWith([{ jid: SARAH, displayName: 'Sarah' }]);
    expect(gate.decide({ remoteJid: SARAH, fromMe: false }).forward).toBe(true);

    gate.setAllowed([]);

    // Unticking takes effect now, not at next launch.
    expect(gate.decide({ remoteJid: SARAH, fromMe: false })).toEqual({
      forward: false,
      reason: 'not_allowed',
    });
  });

  it('never makes a network call for a message it drops', async () => {
    // The strongest form of the promise: there is no fetch on this path AT ALL. We fail the test if the
    // gate so much as looks at the network — which it cannot, having been handed none.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const gate = gateWith([{ jid: SARAH, displayName: 'Sarah' }]);
    for (const jid of [STRANGER, '447700900555@s.whatsapp.net', '120363000000000000@g.us']) {
      expect(gate.decide({ remoteJid: jid, fromMe: false }).forward).toBe(false);
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('puts the self-chat in the sync payload, so it is never empty', () => {
    const chats = gateWith([{ jid: SARAH, displayName: 'Sarah' }]).toSyncPayload('You');

    expect(chats).toHaveLength(2);
    expect(chats[0]).toEqual({ jid: OWN, displayName: 'You', isSelfChat: true });
    expect(chats.some((c) => c.jid === SARAH)).toBe(true);
  });
});
