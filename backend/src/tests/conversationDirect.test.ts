import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db, closeDb } from '../database/index.js';
import { conversationService } from '../services/conversationService.js';
import { conversationRepository } from '../repositories/conversationRepository.js';
import { contactRepository } from '../repositories/contactRepository.js';
import { ForbiddenError } from '../utils/errors.js';

/**
 * A `direct` conversation is a singleton per contact pair: POST /conversations must return the
 * pair's existing thread, never mint a parallel empty one. These tests run against the real
 * `stewra_test` Postgres (see vitest.config.ts) because the claims are about rows — "no second
 * conversation exists", "the membership row was re-activated" — which a stubbed repository would
 * assert nothing about.
 */

// One real bcrypt hash reused across users: nothing here authenticates.
const PASSWORD_HASH = await bcrypt.hash(randomUUID(), 10);

const createdUsers: string[] = [];

/** A real `users` row — conversations and contacts are foreign-keyed to one. */
async function createUser(): Promise<string> {
  const row = await db
    .insertInto('users')
    .values({
      email: `conv-direct-${randomUUID()}@stewra.invalid`,
      display_name: 'Direct Dedupe Test User',
      password_hash: PASSWORD_HASH,
      role: 'user',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  createdUsers.push(row.id);
  return row.id;
}

/** Two users who are mutual contacts — the state every direct-conversation test starts from. */
async function createContactPair(): Promise<[string, string]> {
  const a = await createUser();
  const b = await createUser();
  await contactRepository.createReciprocal(a, b);
  return [a, b];
}

async function directConversationCount(a: string, b: string): Promise<number> {
  const rows = await db
    .selectFrom('conversations')
    .innerJoin('conversation_participants as pa', 'pa.conversation_id', 'conversations.id')
    .innerJoin('conversation_participants as pb', 'pb.conversation_id', 'conversations.id')
    .select('conversations.id')
    .where('conversations.type', '=', 'direct')
    .where('pa.user_id', '=', a)
    .where('pb.user_id', '=', b)
    .execute();
  return rows.length;
}

afterAll(async () => {
  // conversations.created_by, conversation_participants.user_id and both contacts FKs all cascade
  // from users, so deleting the users removes everything each test created.
  if (createdUsers.length > 0) {
    await db.deleteFrom('users').where('id', 'in', createdUsers).execute();
  }
  await closeDb();
});

describe('direct conversation get-or-create', () => {
  it('returns the existing thread instead of creating a duplicate', async () => {
    const [a, b] = await createContactPair();

    const first = await conversationService.create(a, 'direct', [b], null);
    const second = await conversationService.create(a, 'direct', [b], null);
    // Symmetric: the OTHER user starting the chat lands in the same thread too.
    const fromOtherSide = await conversationService.create(b, 'direct', [a], null);

    expect(second.id).toBe(first.id);
    expect(fromOtherSide.id).toBe(first.id);
    expect(await directConversationCount(a, b)).toBe(1);
  });

  it('resurfaces a soft-left thread and re-activates the membership', async () => {
    const [a, b] = await createContactPair();

    const thread = await conversationService.create(a, 'direct', [b], null);
    await conversationService.leave(a, thread.id);
    expect(await conversationRepository.getActiveParticipant(thread.id, a)).toBeUndefined();

    const again = await conversationService.create(a, 'direct', [b], null);

    // The pair's shared history comes back — same thread, membership active again.
    expect(again.id).toBe(thread.id);
    expect(await conversationRepository.getActiveParticipant(thread.id, a)).toBeDefined();
    expect(await directConversationCount(a, b)).toBe(1);
  });

  it('converges pre-existing duplicates on the most-recently-active thread', async () => {
    const [a, b] = await createContactPair();

    // Two duplicates, created straight through the repository the way the un-deduplicated service
    // used to. The OLDER one is then made the active thread (newer last_message_at), because the
    // thread a real pair actually uses is not necessarily the one created last.
    const stale = await conversationRepository.create({
      type: 'direct',
      title: null,
      createdBy: a,
      participantUserIds: [b],
    });
    const active = await conversationRepository.create({
      type: 'direct',
      title: null,
      createdBy: a,
      participantUserIds: [b],
    });
    await db
      .updateTable('conversations')
      .set({ last_message_at: new Date(Date.now() - 60_000) })
      .where('id', '=', stale.id)
      .execute();
    await db
      .updateTable('conversations')
      .set({ last_message_at: new Date() })
      .where('id', '=', active.id)
      .execute();

    const resolved = await conversationService.create(a, 'direct', [b], null);

    expect(resolved.id).toBe(active.id);
    expect(resolved.id).not.toBe(stale.id);
  });

  it('still refuses when the pair are no longer contacts, even though a thread exists', async () => {
    const [a, b] = await createContactPair();
    const thread = await conversationService.create(a, 'direct', [b], null);

    // Sever the contact relationship; the dedupe lookup must NOT run before the contact gate.
    await db
      .deleteFrom('contacts')
      .where((eb) =>
        eb.or([
          eb.and([eb('owner_id', '=', a), eb('contact_user_id', '=', b)]),
          eb.and([eb('owner_id', '=', b), eb('contact_user_id', '=', a)]),
        ]),
      )
      .execute();

    await expect(conversationService.create(a, 'direct', [b], null)).rejects.toThrow(
      ForbiddenError,
    );
    // The existing thread is untouched — refusing to open it is not deleting it.
    expect(await conversationRepository.findById(thread.id)).toBeDefined();
  });
});
