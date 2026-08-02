import { normalizeJid } from './allowlist.js';

/** One pickable chat, as the picker UI renders it. `lastActivity` is epoch ms; 0 = never seen active. */
export interface ChatSummary {
  readonly jid: string;
  readonly displayName: string;
  readonly lastActivity: number;
}

/** The subset of a Baileys chat/contact/message the directory is allowed to look at. */
export interface ChatMeta {
  readonly id: string;
  readonly name?: string | null;
  /** Baileys' `conversationTimestamp`, in SECONDS (WhatsApp wire format). */
  readonly timestampSeconds?: number | null;
}

/**
 * The local directory of chats the user can tick — the data source behind the picker.
 *
 * PURE ACCUMULATOR, same doctrine as `AllowlistGate`: no socket, no filesystem, no Electron, nothing
 * that could make a network call. Baileys events are mapped to plain `ChatMeta` before they get here,
 * and everything this class holds STAYS ON THE USER'S MACHINE — the directory is never synced, never
 * uploaded, and the server only ever learns the chats the user actually ticks.
 *
 * Baileys 6.7.x keeps no chat store and full history sync is off (see whatsapp.ts), so this fills in
 * from what actually arrives: the initial recent-history snapshot, chat/contact upserts, and live
 * messages. The honest consequence, stated in the UI: a silent chat may not be listed until it next
 * receives a message.
 *
 * Individual chats only. Groups, broadcast lists, newsletters and status are filtered at the door —
 * the feature's scope is 1:1 conversations, and a group leaking into the picker would invite the user
 * to point Stewra at other people's conversations at scale.
 */
export class ChatDirectory {
  /** Normalised JID → what we know. `name` is the best-known label, null until anything names it. */
  private readonly chats = new Map<string, { name: string | null; lastActivity: number }>();

  /** 1:1 servers only. `lid` is WhatsApp's newer per-account address — still an individual chat. */
  private isIndividual(normalized: string): boolean {
    const server = normalized.split('@')[1] ?? '';
    return server === 's.whatsapp.net' || server === 'lid';
  }

  private upsert(id: string, name: string | null | undefined, timestampSeconds: number | null | undefined): void {
    const jid = normalizeJid(id);
    if (!this.isIndividual(jid)) return;
    const existing = this.chats.get(jid) ?? { name: null, lastActivity: 0 };
    const activity = typeof timestampSeconds === 'number' && timestampSeconds > 0 ? timestampSeconds * 1000 : 0;
    this.chats.set(jid, {
      // A real name never regresses to null; a newer name wins (contacts.update renames propagate).
      name: typeof name === 'string' && name.trim().length > 0 ? name.trim() : existing.name,
      lastActivity: Math.max(existing.lastActivity, activity),
    });
  }

  /** `messaging-history.set` / `chats.upsert` / `chats.update`: chats with names and last activity. */
  applyChats(chats: readonly ChatMeta[]): void {
    for (const chat of chats) this.upsert(chat.id, chat.name, chat.timestampSeconds);
  }

  /** `contacts.upsert` / `contacts.update`: names only — a contact existing is not chat activity. */
  applyContacts(contacts: readonly ChatMeta[]): void {
    for (const contact of contacts) this.upsert(contact.id, contact.name, null);
  }

  /** Every known chat, most recently active first; unnamed chats fall back to their number. */
  list(): ChatSummary[] {
    return [...this.chats.entries()]
      .map(([jid, meta]) => ({
        jid,
        displayName: meta.name ?? (jid.split('@')[0] ?? jid),
        lastActivity: meta.lastActivity,
      }))
      .sort((a, b) => b.lastActivity - a.lastActivity);
  }

  /** For the encrypted local cache, so the picker is not empty after a restart. */
  serialize(): string {
    return JSON.stringify(
      [...this.chats.entries()].map(([jid, meta]) => ({ jid, name: meta.name, lastActivity: meta.lastActivity })),
    );
  }

  /**
   * Rebuild from `serialize()` output. A cache that does not parse is discarded wholesale — it is a
   * convenience copy of local data that WhatsApp will repopulate, not something worth half-recovering.
   */
  hydrate(json: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return;
    }
    if (!Array.isArray(parsed)) return;
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) continue;
      const jid = Reflect.get(entry, 'jid');
      const name = Reflect.get(entry, 'name');
      const lastActivity = Reflect.get(entry, 'lastActivity');
      if (typeof jid !== 'string') continue;
      this.upsert(
        jid,
        typeof name === 'string' ? name : null,
        typeof lastActivity === 'number' && lastActivity > 0 ? lastActivity / 1000 : null,
      );
    }
  }
}
