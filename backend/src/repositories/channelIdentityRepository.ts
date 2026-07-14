import { randomInt } from 'node:crypto';
import type { ChannelIdentity, MessagingChannel } from '@stewra/shared-types';
import { db } from '../database/index';

/**
 * Ambiguity-free alphabet for the link code: no O/0, I/1, S/5, B/8. The user retypes this into WhatsApp
 * by hand off a screen, so a glyph collision is a real support ticket, not a theoretical one.
 */
const CODE_ALPHABET = 'ACDEFGHJKLMNPQRTUVWXYZ2346789';
const CODE_BODY_LENGTH = 6;
const CODE_PREFIX = 'STEWRA-';

/** Generate a `STEWRA-XXXXXX` code with CSPRNG randomness (randomInt, not Math.random). */
function generateCode(): string {
  let body = '';
  for (let i = 0; i < CODE_BODY_LENGTH; i += 1) {
    body += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return `${CODE_PREFIX}${body}`;
}

/**
 * Render a stored `external_id` for the owner's own eyes.
 *
 * Every channel stores whatever ITS provider calls an address, verbatim — so the presentation rule is
 * per-channel and belongs here, not inlined at the one call site that happens to need it today. Both
 * WhatsApp channels store bare digits (Meta's `wa_id` has no '+', and the bridge normalizes a Baileys
 * JID down to the same shape before it ever reaches the server), so both render as E.164.
 */
function formatAddress(channel: MessagingChannel, externalId: string): string {
  switch (channel) {
    case 'whatsapp':
    case 'whatsapp_personal':
      return `+${externalId}`;
  }
}

/**
 * The phone ⇄ user map and the link-code lifecycle behind it.
 *
 * SECURITY: `findUserIdByAddress` is the single function that converts an unauthenticated webhook
 * payload into a userId. Everything downstream trusts its answer, so a row may only ever be written by
 * `consumeCodeAndLink` — i.e. by someone who proved possession of the logged-in session (they minted
 * the code) AND the phone (they sent it from WhatsApp).
 */
class ChannelIdentityRepository {
  /** Resolve an inbound channel address to its Stewra user, or null if the address isn't linked. */
  async findUserIdByAddress(channel: MessagingChannel, externalId: string): Promise<string | null> {
    const row = await db
      .selectFrom('channel_identities')
      .select('user_id')
      .where('channel', '=', channel)
      .where('external_id', '=', externalId)
      .executeTakeFirst();
    return row?.user_id ?? null;
  }

  /** The user's linked identity on a channel, for the Settings screen. */
  async findByUser(channel: MessagingChannel, userId: string): Promise<ChannelIdentity | null> {
    const row = await db
      .selectFrom('channel_identities')
      .select(['id', 'channel', 'external_id', 'created_at'])
      .where('channel', '=', channel)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (row === undefined) return null;
    return {
      id: row.id,
      channel: row.channel,
      address: formatAddress(row.channel, row.external_id),
      createdAt: row.created_at.toISOString(),
    };
  }

  /**
   * Mint a fresh single-use link code for a user, invalidating any earlier unconsumed one so only the
   * most recent code they were shown can work. Retries on the (astronomically unlikely) code collision.
   */
  async createLinkCode(
    channel: MessagingChannel,
    userId: string,
    ttlMs: number,
  ): Promise<{ code: string; expiresAt: Date }> {
    await db
      .deleteFrom('channel_link_codes')
      .where('channel', '=', channel)
      .where('user_id', '=', userId)
      .where('consumed_at', 'is', null)
      .execute();

    const expiresAt = new Date(Date.now() + ttlMs);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = generateCode();
      try {
        await db
          .insertInto('channel_link_codes')
          .values({ user_id: userId, channel, code, expires_at: expiresAt })
          .execute();
        return { code, expiresAt };
      } catch {
        // Unique violation on `code` — vanishingly rare; just draw again.
      }
    }
    throw new Error('could not mint a unique channel link code');
  }

  /**
   * Burn `code` and return whose it was, WITHOUT binding an address — the redemption the Stewra Bridge
   * performs when it trades a pairing code for a device token.
   *
   * The bridge cannot use `consumeCodeAndLink` because at this moment nobody knows the user's WhatsApp
   * number yet: the bridge hasn't paired with WhatsApp, and it is the bridge (not a webhook) that will
   * later report the number it ends up logged in as. So the code proves only what it can honestly prove
   * here — that the holder was handed it by an authenticated, consented session.
   *
   * The UPDATE's WHERE clause is the atomic guard, exactly as in `consumeCodeAndLink`: two bridges
   * racing on the same code cannot both win, because the second matches zero rows.
   */
  async consumeCode(channel: MessagingChannel, code: string): Promise<string | null> {
    const burned = await db
      .updateTable('channel_link_codes')
      .set({ consumed_at: new Date() })
      .where('channel', '=', channel)
      .where('code', '=', code)
      .where('consumed_at', 'is', null)
      .where('expires_at', '>', new Date())
      .returning('user_id')
      .executeTakeFirst();
    return burned?.user_id ?? null;
  }

  /**
   * Redeem `code` for `externalId`: bind the address to the code's owner and burn the code, atomically.
   * Returns the userId on success, or null if the code is unknown, expired, or already used.
   *
   * Re-linking a number that already belongs to someone (or a user who already linked a different
   * number) REPLACES the prior row — both unique indexes are honoured by deleting first, inside the
   * transaction, so there's no window where a number maps to two users.
   */
  async consumeCodeAndLink(
    channel: MessagingChannel,
    code: string,
    externalId: string,
  ): Promise<string | null> {
    return db.transaction().execute(async (trx) => {
      // Burn the code first: the UPDATE's WHERE is the atomic guard, so two concurrent redemptions of
      // the same code can't both win — the second matches zero rows.
      const burned = await trx
        .updateTable('channel_link_codes')
        .set({ consumed_at: new Date() })
        .where('channel', '=', channel)
        .where('code', '=', code)
        .where('consumed_at', 'is', null)
        .where('expires_at', '>', new Date())
        .returning('user_id')
        .executeTakeFirst();
      if (burned === undefined) return null;

      // This address may have been linked to another account, and this user may have linked another
      // address. Clear both sides, then insert — keeps the two unique indexes satisfied.
      await trx
        .deleteFrom('channel_identities')
        .where('channel', '=', channel)
        .where((eb) =>
          eb.or([
            eb('external_id', '=', externalId),
            eb('user_id', '=', burned.user_id),
          ]),
        )
        .execute();

      await trx
        .insertInto('channel_identities')
        .values({ user_id: burned.user_id, channel, external_id: externalId })
        .execute();

      return burned.user_id;
    });
  }

  /** Unlink the user's address on a channel. Returns true if a link existed. */
  async unlink(channel: MessagingChannel, userId: string): Promise<boolean> {
    const result = await db
      .deleteFrom('channel_identities')
      .where('channel', '=', channel)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  /**
   * Claim a provider message id, returning true only for the FIRST caller. Meta retries a webhook for up
   * to 7 days until it sees a 200, so redelivery is guaranteed — without this claim a retry would replay
   * the user's message into the agent and bill us for a second reply. The unique index IS the lock:
   * losing the insert race means someone else already has it.
   */
  async claimInboundMessage(channel: MessagingChannel, providerMessageId: string): Promise<boolean> {
    try {
      await db
        .insertInto('channel_inbound_messages')
        .values({ channel, provider_message_id: providerMessageId })
        .execute();
      return true;
    } catch {
      return false;
    }
  }
}

export const channelIdentityRepository = new ChannelIdentityRepository();
