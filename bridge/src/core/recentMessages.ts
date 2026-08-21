/**
 * The last N live messages, by provider id, so a reply from Stewra can QUOTE the message it answers.
 *
 * Baileys quotes by handing `sendMessage` the original message object — there is no "quote by id" —
 * and the bridge keeps no message store. So the messages that arrive while the bridge runs are held
 * here, bounded, and only for as long as it runs. A restart forgets them, and a reply that asks to
 * quote a forgotten message FAILS (see `WhatsappClient.quoteOptions`) rather than going out unquoted:
 * in the self-chat an unquoted line from Stewra is a bubble in the person's own voice, which is the
 * exact confusion the quote exists to prevent.
 *
 * Pure, like `waMapping.ts`: a Map with an eviction rule, typed over whatever the caller stores.
 */
export class RecentMessages<M> {
  private readonly byId = new Map<string, M>();

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`RecentMessages capacity must be a positive integer, got ${String(capacity)}`);
    }
  }

  /** Remember one message. The oldest falls out once the store is full. A re-seen id moves to newest. */
  remember(id: string, message: M): void {
    if (this.byId.has(id)) this.byId.delete(id);
    this.byId.set(id, message);
    if (this.byId.size > this.capacity) {
      const oldest = this.byId.keys().next();
      if (!oldest.done) this.byId.delete(oldest.value);
    }
  }

  get(id: string): M | null {
    return this.byId.get(id) ?? null;
  }

  get size(): number {
    return this.byId.size;
  }
}
