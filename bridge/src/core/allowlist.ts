import type { BridgeAllowedChat } from '@stewra/shared-types';

/** A message as Baileys hands it to us, reduced to the fields the gate is allowed to look at. */
export interface IncomingMessage {
  readonly remoteJid: string;
  readonly fromMe: boolean;
}

/**
 * What the gate decided, and why — the reason exists so the app can show the user what it dropped.
 *
 * On a forward, `jid` is the CANONICAL address the server should key on, which is not always the address
 * the message arrived under: WhatsApp addresses the self-chat by LID on some clients and by phone-number
 * JID on others, and both are the same conversation. The gate resolves that here so everything downstream
 * — the server's allowlist lookup, its dedupe, its echo-suppression, and the reply it sends back — agrees
 * on one identity. Get this wrong and each of those keys on a different string, and the loop breaks.
 */
export type GateDecision =
  | { readonly forward: true; readonly isSelfChat: boolean; readonly jid: string }
  | { readonly forward: false; readonly reason: 'not_allowed' | 'not_from_user' };

/**
 * Normalise a JID to the bare `number@server` form.
 *
 * WhatsApp hands the same person to you under several spellings — with a device suffix (`:12`), as a LID,
 * with `@c.us` instead of `@s.whatsapp.net`. If the gate compared raw strings it would silently fail to
 * match a ticked chat, and "silently fail to match" in a filter that is SUPPOSED to block means content
 * leaking off the user's machine. So normalise on both sides, always.
 */
export function normalizeJid(jid: string): string {
  const [user = '', server = ''] = jid.split('@');
  const bare = (user.split(':')[0] ?? '').trim();
  const host = server === 'c.us' ? 's.whatsapp.net' : server;
  return `${bare}@${host}`;
}

/**
 * THE ALLOWLIST GATE — and the whole privacy story of this feature.
 *
 * It runs on the user's OWN computer, inside the `messages.upsert` handler, BEFORE anything touches the
 * network. A chat the user has not ticked is dropped right here: Stewra's servers never learn that it
 * exists, never see a name, never see a word of it. That is a promise we can actually keep, rather than
 * the weaker one a server-side worker could offer ("we received it, then discarded it").
 *
 * Deliberately pure. It takes no socket, no client, no network handle of any kind — so a test can prove
 * that a non-ticked chat produces ZERO outbound calls, because there is nothing here that could make one.
 *
 * Two rules:
 *   - The user's own "Message yourself" chat is always allowed. That is the entire v1 product: you message
 *     yourself, Stewra answers.
 *   - Every other chat is allowed only if the user ticked it in this app, and only messages FROM the other
 *     person are forwarded — Stewra reads what was said to the user, not the user's own half of a
 *     conversation it was never asked to join.
 */
export class AllowlistGate {
  /** Normalised JID → the chat the user ticked. The self-chat is not in here; it is unconditional. */
  private allowed = new Map<string, BridgeAllowedChat>();

  /**
   * @param ownJid the account's phone-number JID (`me@s.whatsapp.net`) — the canonical self identity.
   * @param ownLid the account's LID (`…@lid`), when WhatsApp has assigned one. The self-chat can arrive
   *   addressed by EITHER, so the gate must recognise both; without this, a self-message that comes in as
   *   a LID is silently dropped as "not_allowed" and Stewra never answers. The canonical address it is
   *   forwarded under is always the phone JID, so the server only ever sees one identity for the chat.
   */
  constructor(
    private readonly ownJid: string,
    private readonly ownLid?: string,
  ) {}

  /** Replace the ticked set. The user unticking a chat must take effect at once, not on next launch. */
  setAllowed(chats: readonly BridgeAllowedChat[]): void {
    this.allowed = new Map(
      chats.filter((c) => !c.isSelfChat).map((c) => [normalizeJid(c.jid), c]),
    );
  }

  /** The set as the server should hold it: the ticked chats, plus the always-allowed self-chat. */
  toSyncPayload(selfDisplayName: string): BridgeAllowedChat[] {
    return [
      { jid: normalizeJid(this.ownJid), displayName: selfDisplayName, isSelfChat: true },
      ...this.allowed.values(),
    ];
  }

  isSelfChat(jid: string): boolean {
    const normalized = normalizeJid(jid);
    if (normalized === normalizeJid(this.ownJid)) return true;
    // WhatsApp addresses the user's own "Message yourself" chat by LID on some clients. That is still the
    // self-chat, and must be recognised as one — or the whole v1 product (message yourself, Stewra answers)
    // silently does nothing.
    return this.ownLid !== undefined && normalized === normalizeJid(this.ownLid);
  }

  /** May this message leave the user's computer? Everything else in the app asks this first. */
  decide(message: IncomingMessage): GateDecision {
    const jid = normalizeJid(message.remoteJid);

    if (this.isSelfChat(jid)) {
      // In the self-chat every message is `fromMe` — it is the user, talking to themself, which is exactly
      // the conversation Stewra is here to have. Forward it under the PHONE jid regardless of whether it
      // arrived as a LID: the self-chat is one conversation, and the server must key on one address for it.
      return { forward: true, isSelfChat: true, jid: normalizeJid(this.ownJid) };
    }

    if (!this.allowed.has(jid)) {
      return { forward: false, reason: 'not_allowed' };
    }

    if (message.fromMe) {
      // The user's own outgoing message in someone else's chat. They asked Stewra to read what SARAH says,
      // not to keep a copy of everything they say to her.
      return { forward: false, reason: 'not_from_user' };
    }

    return { forward: true, isSelfChat: false, jid };
  }
}
