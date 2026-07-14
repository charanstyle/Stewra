import { db } from '../database/index';
import { decryptField, encryptField, hmacField } from '../control-plane/vault/fieldCrypto';

/** A chat the user has allowed, as the server holds it. */
export interface StoredChat {
  readonly id: string;
  readonly jid: string;
  readonly isSelfChat: boolean;
}

/** One queued send, decrypted for delivery to the bridge. */
export interface PendingSend {
  readonly outboxId: string;
  readonly jid: string;
  readonly text: string;
}

/**
 * The WhatsApp store for the experimental companion-device channel: the allowed chats, their messages,
 * and the outbox.
 *
 * Everything sensitive is encrypted at rest with `encryptField` (the same AES-256-GCM as the vault),
 * exactly as `email_messages.body_ciphertext` already is — a WhatsApp body is not a new category of
 * data for Stewra, it is the same category arriving on a different wire.
 *
 * The JID gets both treatments: `jid_ciphertext` so we can hand it back to the bridge, and `jid_hmac` so
 * we can look it up by equality without holding a brute-forceable handle on a phone number.
 */
class WhatsappStore {
  /**
   * Replace the user's allowlist with the device's authoritative set: upsert what they allow, DELETE what
   * they no longer do — which cascades that chat's stored messages away.
   *
   * Unticking a chat must actually erase what we held for it. Anything less would make "stop reading this
   * chat" a promise about the future only, while quietly keeping the past.
   *
   * Refuses an EMPTY set rather than obeying it: the self-chat is always allowed, so an empty list is a
   * broken bridge, and a bug must never be executed as an instruction to delete everything.
   */
  async replaceAllowedChats(
    userId: string,
    chats: ReadonlyArray<{ jid: string; displayName: string; isSelfChat: boolean }>,
  ): Promise<void> {
    if (chats.length === 0) {
      throw new Error('refusing an empty allowlist: the self-chat is always allowed, so this is a bug');
    }

    const hmacs = chats.map((c) => hmacField(c.jid));

    await db.transaction().execute(async (trx) => {
      for (const chat of chats) {
        await trx
          .insertInto('whatsapp_chats')
          .values({
            user_id: userId,
            jid_hmac: hmacField(chat.jid),
            jid_ciphertext: encryptField(chat.jid),
            display_name_ciphertext: encryptField(chat.displayName),
            is_self_chat: chat.isSelfChat,
          })
          .onConflict((oc) =>
            oc.columns(['user_id', 'jid_hmac']).doUpdateSet({
              display_name_ciphertext: encryptField(chat.displayName),
              is_self_chat: chat.isSelfChat,
              updated_at: new Date(),
            }),
          )
          .execute();
      }

      await trx
        .deleteFrom('whatsapp_chats')
        .where('user_id', '=', userId)
        .where('jid_hmac', 'not in', hmacs)
        .execute();
    });
  }

  /**
   * The allowed chat for this JID, or null.
   *
   * Returning null is the SERVER-SIDE enforcement of the allowlist. The device is supposed to filter
   * before sending, but "the client promised" is not a security control — a compromised or buggy bridge
   * must not be able to push us content from a chat the user never allowed. Two independent gates.
   */
  async findChatByJid(userId: string, jid: string): Promise<StoredChat | null> {
    const row = await db
      .selectFrom('whatsapp_chats')
      .select(['id', 'jid_ciphertext', 'is_self_chat'])
      .where('user_id', '=', userId)
      .where('jid_hmac', '=', hmacField(jid))
      .executeTakeFirst();
    if (row === undefined) return null;
    return { id: row.id, jid: decryptField(row.jid_ciphertext), isSelfChat: row.is_self_chat };
  }

  /** The allowed chat with this id, scoped to its owner so an id alone is never enough to read one. */
  async findChatById(userId: string, chatId: string): Promise<StoredChat | null> {
    const row = await db
      .selectFrom('whatsapp_chats')
      .select(['id', 'jid_ciphertext', 'is_self_chat'])
      .where('user_id', '=', userId)
      .where('id', '=', chatId)
      .executeTakeFirst();
    if (row === undefined) return null;
    return { id: row.id, jid: decryptField(row.jid_ciphertext), isSelfChat: row.is_self_chat };
  }

  /** Persist a message in an allowed chat. Body encrypted at rest. */
  async recordMessage(params: {
    userId: string;
    chatId: string;
    providerMessageId: string;
    direction: 'inbound' | 'outbound';
    fromMe: boolean;
    text: string;
    sentAt: Date;
  }): Promise<void> {
    await db
      .insertInto('whatsapp_messages')
      .values({
        user_id: params.userId,
        chat_id: params.chatId,
        provider_message_id: params.providerMessageId,
        direction: params.direction,
        from_me: params.fromMe,
        body_ciphertext: encryptField(params.text),
        sent_at: params.sentAt,
      })
      // The unique (chat_id, provider_message_id) index makes a redelivery a no-op rather than a crash.
      .onConflict((oc) => oc.columns(['chat_id', 'provider_message_id']).doNothing())
      .execute();
  }

  /**
   * Queue an approved send. Enqueued BEFORE any attempt to deliver it, because the bridge may simply be
   * off — the user's laptop is shut. A closed lid then costs latency, never a lost message.
   */
  async enqueueSend(userId: string, chatId: string, text: string): Promise<string> {
    const row = await db
      .insertInto('whatsapp_outbound')
      .values({ user_id: userId, chat_id: chatId, body_ciphertext: encryptField(text) })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** Everything still waiting for a bridge to come and take it, oldest first. */
  async pendingSends(userId: string): Promise<PendingSend[]> {
    const rows = await db
      .selectFrom('whatsapp_outbound')
      .innerJoin('whatsapp_chats', 'whatsapp_chats.id', 'whatsapp_outbound.chat_id')
      .select([
        'whatsapp_outbound.id as id',
        'whatsapp_outbound.body_ciphertext as body_ciphertext',
        'whatsapp_chats.jid_ciphertext as jid_ciphertext',
      ])
      .where('whatsapp_outbound.user_id', '=', userId)
      .where('whatsapp_outbound.status', '=', 'pending')
      .orderBy('whatsapp_outbound.created_at', 'asc')
      .execute();

    return rows.map((r) => ({
      outboxId: r.id,
      jid: decryptField(r.jid_ciphertext),
      text: decryptField(r.body_ciphertext),
    }));
  }

  /** The bridge delivered it. Record which device did, and what WhatsApp called the message. */
  async markSent(outboxId: string, deviceId: string, providerMessageId: string): Promise<void> {
    await db
      .updateTable('whatsapp_outbound')
      .set({
        status: 'sent',
        device_id: deviceId,
        provider_message_id: providerMessageId,
        sent_at: new Date(),
      })
      .where('id', '=', outboxId)
      .execute();
  }

  /**
   * The send failed. Left `pending` on a transient failure so the next bridge retries it, but marked
   * `failed` once it has been tried too often — a message that can never be delivered must stop being
   * retried forever, and must be visible rather than silently looping.
   */
  async markAttemptFailed(outboxId: string, error: string, maxAttempts: number): Promise<void> {
    const row = await db
      .updateTable('whatsapp_outbound')
      .set((eb) => ({ attempts: eb('attempts', '+', 1), last_error: error.slice(0, 500) }))
      .where('id', '=', outboxId)
      .returning('attempts')
      .executeTakeFirst();

    if (row !== undefined && row.attempts >= maxAttempts) {
      await db
        .updateTable('whatsapp_outbound')
        .set({ status: 'failed' })
        .where('id', '=', outboxId)
        .execute();
    }
  }

  /** Force-fail a send without retrying — used when continuing would be unsafe (see the loop breaker). */
  async markFailed(outboxId: string, error: string): Promise<void> {
    await db
      .updateTable('whatsapp_outbound')
      .set({ status: 'failed', last_error: error.slice(0, 500) })
      .where('id', '=', outboxId)
      .execute();
  }

  /** Delete stored messages older than the cutoff. Returns how many went. */
  async deleteMessagesOlderThan(userId: string, cutoff: Date): Promise<number> {
    const result = await db
      .deleteFrom('whatsapp_messages')
      .where('user_id', '=', userId)
      .where('created_at', '<', cutoff)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  /** Every user holding stored WhatsApp content — the retention sweep's work list. */
  async userIdsWithStoredMessages(): Promise<string[]> {
    const rows = await db
      .selectFrom('whatsapp_messages')
      .select('user_id')
      .distinct()
      .execute();
    return rows.map((r) => r.user_id);
  }
}

export const whatsappStore = new WhatsappStore();
