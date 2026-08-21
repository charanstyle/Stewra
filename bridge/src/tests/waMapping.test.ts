import { describe, expect, it } from 'vitest';
import { proto } from '@whiskeysockets/baileys';
import {
  extractLid,
  extractStatusCode,
  extractText,
  extractVoiceNote,
  mapUpsert,
  metas,
  renderQr,
  toMeta,
} from '../core/waMapping.js';

/**
 * The pure mapping layer, tested against REAL Baileys protobuf objects (`proto.WebMessageInfo.fromObject`,
 * the authState.test.ts pattern) — the same shapes a live socket emits, minus the socket.
 */

/** A real WebMessageInfo, as Baileys would deliver it. */
function realMessage(fields: {
  remoteJid?: string;
  id?: string;
  fromMe?: boolean;
  pushName?: string;
  timestampSeconds?: number;
  text?: string;
}): proto.WebMessageInfo {
  return proto.WebMessageInfo.fromObject({
    key: {
      ...(fields.remoteJid !== undefined ? { remoteJid: fields.remoteJid } : {}),
      ...(fields.id !== undefined ? { id: fields.id } : {}),
      fromMe: fields.fromMe ?? false,
    },
    ...(fields.pushName !== undefined ? { pushName: fields.pushName } : {}),
    ...(fields.timestampSeconds !== undefined ? { messageTimestamp: fields.timestampSeconds } : {}),
    ...(fields.text !== undefined ? { message: { conversation: fields.text } } : {}),
  });
}

const FIXED_NOW = new Date('2026-08-01T12:00:00.000Z');
const now = (): Date => FIXED_NOW;

describe('mapUpsert on real Baileys WebMessageInfo batches', () => {
  it('acts on a notify batch: chat activity mapped, live message carried with its epoch timestamp', () => {
    const outcome = mapUpsert(
      {
        messages: [
          realMessage({
            remoteJid: '1@s.whatsapp.net',
            id: 'MSG-1',
            pushName: 'Ana',
            timestampSeconds: 1_700_000_000,
            text: 'hello',
          }),
        ],
        type: 'notify',
      },
      now,
    );

    expect(outcome.actedOn).toBe(true);
    expect(outcome.dropped).toEqual([]);
    expect(outcome.chatActivity).toEqual([
      { id: '1@s.whatsapp.net', name: 'Ana', timestampSeconds: 1_700_000_000 },
    ]);
    expect(outcome.live).toEqual([
      {
        providerMessageId: 'MSG-1',
        remoteJid: '1@s.whatsapp.net',
        fromMe: false,
        text: 'hello',
        voice: null,
        sentAt: new Date(1_700_000_000_000),
      },
    ]);
  });

  it('carries a voice note as a live message with its header and the raw message to download from', () => {
    const raw = proto.WebMessageInfo.fromObject({
      key: { remoteJid: '1@s.whatsapp.net', id: 'PTT-1', fromMe: true },
      messageTimestamp: 1_700_000_000,
      message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: 7 } },
    });
    const outcome = mapUpsert({ messages: [raw], type: 'notify' }, now);

    expect(outcome.dropped).toEqual([]);
    expect(outcome.live).toHaveLength(1);
    expect(outcome.live[0]).toMatchObject({
      providerMessageId: 'PTT-1',
      remoteJid: '1@s.whatsapp.net',
      fromMe: true,
      text: null,
      voice: { mime: 'audio/ogg', seconds: 7 },
    });
    expect(outcome.live[0]?.voice?.raw).toBe(raw);
  });

  it('still drops an audio FILE — only the push-to-talk gesture is a message to Stewra', () => {
    const outcome = mapUpsert(
      {
        messages: [
          proto.WebMessageInfo.fromObject({
            key: { remoteJid: '1@s.whatsapp.net', id: 'SONG-1', fromMe: true },
            message: { audioMessage: { mimetype: 'audio/mp4', ptt: false, seconds: 180 } },
          }),
        ],
        type: 'notify',
      },
      now,
    );
    expect(outcome.live).toEqual([]);
    expect(outcome.dropped).toEqual([{ remoteJid: '1@s.whatsapp.net', fromMe: true }]);
  });

  it('never acts on an append batch — history must not be answered — but still surfaces chat activity', () => {
    const outcome = mapUpsert(
      {
        messages: [
          realMessage({ remoteJid: '1@s.whatsapp.net', id: 'OLD-1', timestampSeconds: 5, text: 'days ago' }),
        ],
        type: 'append',
      },
      now,
    );

    expect(outcome.actedOn).toBe(false);
    expect(outcome.live).toEqual([]);
    expect(outcome.dropped).toEqual([]);
    expect(outcome.chatActivity).toHaveLength(1);
  });

  it('drops a non-text message and records the drop', () => {
    const outcome = mapUpsert(
      { messages: [realMessage({ remoteJid: '1@s.whatsapp.net', id: 'IMG-1', fromMe: true })], type: 'notify' },
      now,
    );

    expect(outcome.live).toEqual([]);
    expect(outcome.dropped).toEqual([{ remoteJid: '1@s.whatsapp.net', fromMe: true }]);
  });

  it("never lets a fromMe pushName — the USER'S OWN name — label someone else's chat", () => {
    const outcome = mapUpsert(
      {
        messages: [
          realMessage({
            remoteJid: '1@s.whatsapp.net',
            id: 'MSG-2',
            fromMe: true,
            pushName: 'The User Themselves',
            timestampSeconds: 10,
            text: 'my reply',
          }),
        ],
        type: 'notify',
      },
      now,
    );

    expect(outcome.chatActivity).toEqual([{ id: '1@s.whatsapp.net', name: null, timestampSeconds: 10 }]);
  });

  it('falls back to the injected clock when the timestamp is missing', () => {
    const outcome = mapUpsert(
      { messages: [realMessage({ remoteJid: '1@s.whatsapp.net', id: 'MSG-3', text: 'untimed' })], type: 'notify' },
      now,
    );

    expect(outcome.live[0]?.sentAt).toEqual(FIXED_NOW);
  });

  it('skips a message with no jid or no id entirely', () => {
    const outcome = mapUpsert(
      {
        messages: [
          realMessage({ id: 'NO-JID', text: 'x' }),
          realMessage({ remoteJid: '1@s.whatsapp.net', text: 'no id' }),
        ],
        type: 'notify',
      },
      now,
    );

    expect(outcome.live).toEqual([]);
    expect(outcome.dropped).toEqual([]);
  });
});

describe('toMeta / metas', () => {
  it('prefers the chat name, then a verified business name, then the broadcast push name', () => {
    expect(toMeta({ id: 'j', name: 'Book', verifiedName: 'Biz', notify: 'Push' })?.name).toBe('Book');
    expect(toMeta({ id: 'j', verifiedName: 'Biz', notify: 'Push' })?.name).toBe('Biz');
    expect(toMeta({ id: 'j', notify: 'Push' })?.name).toBe('Push');
    expect(toMeta({ id: 'j' })?.name).toBeNull();
  });

  it('rejects an id-less item, and metas filters it out', () => {
    expect(toMeta({ name: 'ghost' })).toBeNull();
    expect(metas([{ name: 'ghost' }, { id: 'j' }])).toEqual([{ id: 'j', name: null, timestampSeconds: null }]);
  });

  it('keeps only positive finite timestamps', () => {
    expect(toMeta({ id: 'j', conversationTimestamp: 100 })?.timestampSeconds).toBe(100);
    expect(toMeta({ id: 'j', conversationTimestamp: 0 })?.timestampSeconds).toBeNull();
    expect(toMeta({ id: 'j', conversationTimestamp: 'soon' })?.timestampSeconds).toBeNull();
  });
});

describe('extractText', () => {
  it('reads plain and extended text, and rejects whitespace-only and non-text content', () => {
    expect(extractText(realMessage({ text: 'plain' }))).toBe('plain');
    expect(
      extractText(proto.WebMessageInfo.fromObject({ message: { extendedTextMessage: { text: 'quoted reply' } } })),
    ).toBe('quoted reply');
    expect(extractText(realMessage({ text: '   ' }))).toBeNull();
    expect(extractText(realMessage({}))).toBeNull();
  });
});

describe('extractVoiceNote', () => {
  it('reads the container and length off a real PTT audioMessage, and rejects everything else', () => {
    const ptt = (fields: { mimetype?: string; ptt?: boolean; seconds?: number }): proto.WebMessageInfo =>
      proto.WebMessageInfo.fromObject({ message: { audioMessage: fields } });
    expect(extractVoiceNote(ptt({ mimetype: 'audio/ogg; codecs=opus', ptt: true, seconds: 3 }))).toEqual({
      mime: 'audio/ogg',
      seconds: 3,
    });
    // No duration reported: the header still stands, with seconds unknown.
    expect(extractVoiceNote(ptt({ mimetype: 'AUDIO/OGG', ptt: true }))).toEqual({ mime: 'audio/ogg', seconds: null });
    expect(extractVoiceNote(ptt({ mimetype: 'audio/ogg', ptt: false }))).toBeNull();
    expect(extractVoiceNote(ptt({ ptt: true }))).toBeNull();
    expect(extractVoiceNote(realMessage({ text: 'words' }))).toBeNull();
    expect(extractVoiceNote(realMessage({}))).toBeNull();
  });
});

describe('extractStatusCode', () => {
  it('reads the Boom-shaped output.statusCode off a real Error', () => {
    const error = Object.assign(new Error('Connection Failure'), { output: { statusCode: 515 } });
    expect(extractStatusCode(error)).toBe(515);
  });

  it('is undefined for a plain Error, a malformed shape, and no error at all', () => {
    expect(extractStatusCode(new Error('just died'))).toBeUndefined();
    expect(extractStatusCode(Object.assign(new Error('x'), { output: 'nope' }))).toBeUndefined();
    expect(extractStatusCode(undefined)).toBeUndefined();
  });
});

describe('extractLid', () => {
  it('reads a real lid and rejects absence and emptiness', () => {
    expect(extractLid({ id: '1:2@s.whatsapp.net', lid: '99@lid' })).toBe('99@lid');
    expect(extractLid({ id: '1:2@s.whatsapp.net' })).toBeNull();
    expect(extractLid({ lid: '' })).toBeNull();
  });
});

describe('renderQr', () => {
  it('renders a real PNG data URL', async () => {
    const dataUrl = await renderQr('2@AbCdEfGh,pairing-ref,keydata==');
    expect(dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it('is null when the library cannot render — a real qrcode rejection, deliberately non-fatal', async () => {
    expect(await renderQr('')).toBeNull();
  });
});
