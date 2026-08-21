import type { proto } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import type { ChatMeta } from './chatDirectory.js';

/**
 * The pure mapping layer between Baileys' event shapes and what the bridge acts on.
 *
 * Same doctrine as `reconnect.ts` and `chatDirectory.ts`: no socket, no filesystem, no Electron —
 * data in, data out — so every rule in here is a unit test against real Baileys protobuf objects
 * rather than something we find out about in production. `whatsapp.ts` stays a thin shell that
 * feeds these functions from `sock.ev` and emits what they return.
 *
 * Parameter types are STRUCTURAL on purpose (the exact fields read, each optional prop admitting
 * `null | undefined`): real Baileys event objects assign to them by reference with no casts, and
 * the functions stay callable from tests without importing Baileys' whole event map.
 */

interface MessageIdentity {
  readonly providerMessageId: string;
  readonly remoteJid: string;
  readonly fromMe: boolean;
  readonly sentAt: Date;
}

/** A voice note's bytes, once downloaded and decrypted on this machine. */
export interface VoiceNote {
  readonly data: Buffer;
  /** MIME type without codec parameters, e.g. `audio/ogg`. */
  readonly mime: string;
  readonly seconds: number | null;
}

/**
 * One WhatsApp message, reduced to what the bridge is willing to look at: its text, or — for a voice
 * note — its audio. Exactly one of the two is set, and the type says so.
 */
export type WhatsappMessage = MessageIdentity &
  ({ readonly text: string; readonly voice: null } | { readonly text: null; readonly voice: VoiceNote });

/** The text of a message, or null for anything we do not handle (media, reactions, protocol messages). */
export function extractText(message: { readonly message?: proto.IMessage | null | undefined }): string | null {
  const content = message.message;
  if (!content) return null;
  const text = content.conversation ?? content.extendedTextMessage?.text ?? null;
  return text !== null && text.trim().length > 0 ? text : null;
}

/** What a voice note looks like before its bytes are fetched: the container type and length. */
export interface VoiceNoteHeader {
  readonly mime: string;
  readonly seconds: number | null;
}

/**
 * The header of a VOICE NOTE — `audioMessage` with `ptt` (push-to-talk) set — or null for anything
 * else, including an audio file shared from the phone's storage. The voice-note gesture is the one
 * that means "I am talking to you"; a forwarded song is not a command, so it stays out of scope.
 */
export function extractVoiceNote(message: { readonly message?: proto.IMessage | null | undefined }): VoiceNoteHeader | null {
  const audio = message.message?.audioMessage;
  if (audio === null || audio === undefined || audio.ptt !== true) return null;
  const mimetype = audio.mimetype ?? '';
  // WhatsApp says `audio/ogg; codecs=opus`; the server keys on the container alone.
  const mime = mimetype.split(';')[0]?.trim().toLowerCase() ?? '';
  if (mime.length === 0) return null;
  const seconds = typeof audio.seconds === 'number' && audio.seconds > 0 ? audio.seconds : null;
  return { mime, seconds };
}

/** The fields the chat directory reads off a Baileys chat, contact, or history entry. */
export interface RawChatMeta {
  readonly id?: string | null | undefined;
  readonly name?: string | null | undefined;
  readonly notify?: string | null | undefined;
  readonly verifiedName?: string | null | undefined;
  readonly conversationTimestamp?: unknown;
}

/**
 * Reduce one Baileys chat/contact shape to a `ChatMeta`, so `chatDirectory.ts` stays free of
 * Baileys types. Everything this feeds only ever powers the picker UI on this machine.
 */
export function toMeta(item: RawChatMeta): ChatMeta | null {
  if (item.id === null || item.id === undefined || item.id.length === 0) return null;
  const seconds = Number(item.conversationTimestamp ?? 0);
  return {
    id: item.id,
    // Best label available: the address-book/chat name, else a business's verified name, else the
    // push name the person broadcasts.
    name: item.name ?? item.verifiedName ?? item.notify ?? null,
    timestampSeconds: Number.isFinite(seconds) && seconds > 0 ? seconds : null,
  };
}

export function metas(items: readonly RawChatMeta[]): ChatMeta[] {
  return items.map(toMeta).filter((m): m is ChatMeta => m !== null);
}

/** The fields `messages.upsert` handling reads off one Baileys WAMessage. */
export interface RawUpsertMessage {
  readonly key?:
    | {
        readonly remoteJid?: string | null | undefined;
        readonly id?: string | null | undefined;
        readonly fromMe?: boolean | null | undefined;
      }
    | null
    | undefined;
  readonly pushName?: string | null | undefined;
  /** number | Long — `Number()` handles both, same as `toMeta`'s conversationTimestamp. */
  readonly messageTimestamp?: unknown;
  readonly message?: proto.IMessage | null | undefined;
}

/**
 * A live message as the mapping layer hands it over: text is already in hand; a voice note is only a
 * header plus the raw Baileys message it must be downloaded from (the download needs the socket, so
 * it happens in `whatsapp.ts`, not here). `M` is the caller's message type, kept so the raw message
 * goes back to Baileys as exactly what it was.
 */
export type LiveMessage<M extends RawUpsertMessage> = MessageIdentity &
  (
    | { readonly text: string; readonly voice: null }
    | { readonly text: null; readonly voice: VoiceNoteHeader & { readonly raw: M } }
  );

export interface UpsertOutcome<M extends RawUpsertMessage = RawUpsertMessage> {
  /** Chat activity for EVERY batch type — a chat having history is exactly what makes it pickable. */
  readonly chatActivity: ChatMeta[];
  /** Messages to act on. Only ever populated for a `notify` batch. */
  readonly live: LiveMessage<M>[];
  /** Other messages in a `notify` batch (images, files, reactions) — logged as dropped, never acted on. */
  readonly dropped: readonly { readonly remoteJid: string; readonly fromMe: boolean }[];
  /** False ⇔ the batch is history filling in (`append`), which must never be answered. */
  readonly actedOn: boolean;
}

/**
 * Everything `messages.upsert` decides, as data.
 *
 * - Directory activity is mapped for EVERY batch, and a fromMe pushName is the USER'S OWN name —
 *   it is never allowed to become the label of someone else's chat.
 * - Only `notify` is a message arriving now. Acting on `append` would make Stewra answer messages
 *   from days ago the moment a bridge comes online.
 *
 * `now` is injected the same way `decideReconnect` takes its RNG: so the timestamp fallback is a
 * testable rule instead of a hidden clock read.
 */
export function mapUpsert<M extends RawUpsertMessage>(
  event: { readonly messages: readonly M[]; readonly type: string },
  now: () => Date = () => new Date(),
): UpsertOutcome<M> {
  const chatActivity = metas(
    event.messages.map((message) => ({
      id: message.key?.remoteJid,
      name: message.key?.fromMe === true ? null : (message.pushName ?? null),
      conversationTimestamp: message.messageTimestamp,
    })),
  );

  const actedOn = event.type === 'notify';
  const live: LiveMessage<M>[] = [];
  const dropped: { remoteJid: string; fromMe: boolean }[] = [];
  if (actedOn) {
    for (const message of event.messages) {
      const remoteJid = message.key?.remoteJid;
      const providerMessageId = message.key?.id;
      if (remoteJid === null || remoteJid === undefined) continue;
      if (providerMessageId === null || providerMessageId === undefined) continue;

      const seconds = Number(message.messageTimestamp ?? 0);
      const identity: MessageIdentity = {
        providerMessageId,
        remoteJid,
        fromMe: message.key?.fromMe === true,
        sentAt: seconds > 0 ? new Date(seconds * 1000) : now(),
      };

      const text = extractText(message);
      if (text !== null) {
        live.push({ ...identity, text, voice: null });
        continue;
      }
      const voice = extractVoiceNote(message);
      if (voice !== null) {
        live.push({ ...identity, text: null, voice: { ...voice, raw: message } });
        continue;
      }
      dropped.push({ remoteJid, fromMe: identity.fromMe });
    }
  }

  return { chatActivity, live, dropped, actedOn };
}

/** Baileys reports the close reason as a Boom error; the code is the only part of it we act on. */
export function extractStatusCode(error: Error | undefined): number | undefined {
  if (error === undefined) return undefined;
  const output = Reflect.get(error, 'output');
  if (typeof output !== 'object' || output === null) return undefined;
  const statusCode = Reflect.get(output, 'statusCode');
  return typeof statusCode === 'number' ? statusCode : undefined;
}

/**
 * The user's LID (`…@lid`) off Baileys' `sock.user`, WhatsApp's newer per-account address. Read
 * defensively: the LID is not part of Baileys' published `user` shape in every version, so we do
 * not depend on the type. Null on accounts WhatsApp has not assigned one.
 */
export function extractLid(user: object): string | null {
  const lid = Reflect.get(user, 'lid');
  return typeof lid === 'string' && lid.length > 0 ? lid : null;
}

/** One entry of a Baileys `onWhatsApp` (USync) answer, reduced to the fields we read. */
export interface UsyncEntry {
  readonly jid?: string | null | undefined;
  readonly lid?: unknown;
  /** Part of the answer; deliberately not consulted — we are asking about our own account's LID, not
   * whether the number is on WhatsApp, and an entry can say `exists` while carrying no LID. */
  readonly exists?: unknown;
}

/**
 * The account's own LID out of a `sock.onWhatsApp(ownJid)` answer.
 *
 * This is the second place a LID can come from, and the one that matters: `extractLid` reads what the
 * open handshake happened to carry, and a QR-linked session is routinely handed NOTHING there — while
 * the phone still addresses the self-chat by LID. The USync directory query is WhatsApp's own answer to
 * "what is the LID for this number", so nothing here is inferred; we either get told or we do not.
 *
 * Null when the answer has no entry for this account or the entry carries no LID string. The caller
 * says so out loud — a missing LID is not papered over with a guess, because a wrong self-identity
 * would let another person's chat be treated as the user's own.
 */
export function lidFromUsync(entries: readonly UsyncEntry[] | undefined, ownJid: string): string | null {
  if (entries === undefined) return null;
  const wanted = bareUser(ownJid);
  for (const entry of entries) {
    if (typeof entry.jid !== 'string' || bareUser(entry.jid) !== wanted) continue;
    if (typeof entry.lid === 'string' && entry.lid.length > 0) return entry.lid;
  }
  return null;
}

/** The `user` part of a JID, without any device suffix — how two spellings of one account are compared. */
function bareUser(jid: string): string {
  return (jid.split('@')[0] ?? '').split(':')[0] ?? '';
}

/**
 * Render a WhatsApp pairing QR as a PNG `data:` URL, sized for the app window.
 *
 * Null on a QR the library cannot render — the contract admits absence because a failed render is
 * deliberately non-fatal: WhatsApp rotates the code every ~20s and the next one replaces it.
 */
export async function renderQr(qr: string): Promise<string | null> {
  try {
    return await QRCode.toDataURL(qr, { margin: 2, width: 320 });
  } catch {
    return null;
  }
}
