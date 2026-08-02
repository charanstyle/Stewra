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

/** One WhatsApp message, reduced to what the bridge is willing to look at. */
export interface WhatsappMessage {
  readonly providerMessageId: string;
  readonly remoteJid: string;
  readonly fromMe: boolean;
  readonly text: string;
  readonly sentAt: Date;
}

/** The text of a message, or null for anything we do not handle (media, reactions, protocol messages). */
export function extractText(message: { readonly message?: proto.IMessage | null | undefined }): string | null {
  const content = message.message;
  if (!content) return null;
  const text = content.conversation ?? content.extendedTextMessage?.text ?? null;
  return text !== null && text.trim().length > 0 ? text : null;
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

export interface UpsertOutcome {
  /** Chat activity for EVERY batch type — a chat having history is exactly what makes it pickable. */
  readonly chatActivity: ChatMeta[];
  /** Messages to act on. Only ever populated for a `notify` batch. */
  readonly live: WhatsappMessage[];
  /** Non-text messages in a `notify` batch (media, reactions) — logged as dropped, never acted on. */
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
export function mapUpsert(
  event: { readonly messages: readonly RawUpsertMessage[]; readonly type: string },
  now: () => Date = () => new Date(),
): UpsertOutcome {
  const chatActivity = metas(
    event.messages.map((message) => ({
      id: message.key?.remoteJid,
      name: message.key?.fromMe === true ? null : (message.pushName ?? null),
      conversationTimestamp: message.messageTimestamp,
    })),
  );

  const actedOn = event.type === 'notify';
  const live: WhatsappMessage[] = [];
  const dropped: { remoteJid: string; fromMe: boolean }[] = [];
  if (actedOn) {
    for (const message of event.messages) {
      const remoteJid = message.key?.remoteJid;
      const providerMessageId = message.key?.id;
      if (remoteJid === null || remoteJid === undefined) continue;
      if (providerMessageId === null || providerMessageId === undefined) continue;

      const text = extractText(message);
      if (text === null) {
        dropped.push({ remoteJid, fromMe: message.key?.fromMe === true });
        continue;
      }

      const seconds = Number(message.messageTimestamp ?? 0);
      live.push({
        providerMessageId,
        remoteJid,
        fromMe: message.key?.fromMe === true,
        text,
        sentAt: seconds > 0 ? new Date(seconds * 1000) : now(),
      });
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
