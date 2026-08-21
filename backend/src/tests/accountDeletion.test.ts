import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db, closeDb } from '../database/index.js';
import { accountDeletionService } from '../services/accountDeletionService.js';
import { vault } from '../control-plane/vault/vault.js';
import { ConflictError } from '../utils/errors.js';
import { orgBillingRegistry } from '../ports/orgBilling.js';
import { orgBillingReader } from '../commerce/services/orgBillingReader.js';

// This file drives the service directly rather than through `createApp()`, so the composition root
// never runs and the billing port would be empty — and `preview()` throws on an empty port rather than
// report "nothing will charge you". The real commerce reader is registered here, against the real
// database, exactly as `app.ts` does it.
orgBillingRegistry.register(orgBillingReader);

/**
 * Account deletion — the claim that deletion is real, tested against the things that make it not.
 *
 * Every assertion here corresponds to a way the previous state of the schema made deletion either
 * impossible or dishonest, and every one of them was found by reading the live database rather than
 * the code:
 *
 *  - `organizations.created_by` was `NOT NULL … ON DELETE RESTRICT`, so any user who had created an
 *    org could not be deleted at all.
 *  - Three append-only triggers raised on their own `SET NULL` foreign keys, so a user who had ever
 *    recorded a consent, loaded a rate card or authored a plan version could not be deleted either.
 *  - `conversations.created_by` was `ON DELETE CASCADE`, so deleting one user destroyed group
 *    threads belonging to everyone in them.
 *  - `vault_secrets` has no foreign key to anything, so encrypted tokens and addresses survived the
 *    cascade as unreachable orphans.
 *
 * Real Postgres, necessarily. Three of the four are enforced by triggers and foreign keys; there is
 * nothing in TypeScript to test, and a mocked `db` would have reported success for every one of them.
 */

const PASSWORD_HASH = await bcrypt.hash(randomUUID(), 10);

async function makeUser(label: string): Promise<string> {
  const row = await db
    .insertInto('users')
    .values({
      email: `del-${label}-${randomUUID()}@stewra.invalid`,
      display_name: `Deletion Test ${label}`,
      password_hash: PASSWORD_HASH,
      role: 'user',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function makeOrg(createdBy: string): Promise<string> {
  const org = await db
    .insertInto('organizations')
    .values({ name: `Del Org ${randomUUID()}`, slug: `del-${randomUUID()}`, created_by: createdBy })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('org_members')
    .values({ org_id: org.id, user_id: createdBy, role: 'owner' })
    .execute();
  return org.id;
}

async function userExists(userId: string): Promise<boolean> {
  const row = await db
    .selectFrom('users')
    .select('id')
    .where('id', '=', userId)
    .executeTakeFirst();
  return row !== undefined;
}

const createdUsers: string[] = [];

async function track(label: string): Promise<string> {
  const id = await makeUser(label);
  createdUsers.push(id);
  return id;
}

afterAll(async () => {
  // Best-effort cleanup of anything a failing assertion left behind. Deletion is the subject here,
  // so a leaked row is a test-hygiene problem rather than a product one.
  for (const id of createdUsers) {
    await db.deleteFrom('users').where('id', '=', id).execute();
  }
  await closeDb();
});

describe('account deletion', () => {
  it('deletes a plain user and every row that cascades from them', async () => {
    const userId = await track('plain');

    await db
      .insertInto('audit_log')
      .values({
        user_id: userId,
        action: 'auth.login',
        resource_type: 'auth',
        resource_id: userId,
        summary: 'Signed in',
        success: true,
        metadata: JSON.stringify({}),
      })
      .execute();

    await db
      .insertInto('user_preferences')
      .values({ user_id: userId, gmail_lookback_days: 7 })
      .onConflict((oc) => oc.doNothing())
      .execute();

    const result = await accountDeletionService.delete(userId);

    expect(result.deleted).toBe(true);
    expect(await userExists(userId)).toBe(false);

    // The preferences row cascaded.
    const prefs = await db
      .selectFrom('user_preferences')
      .select('user_id')
      .where('user_id', '=', userId)
      .executeTakeFirst();
    expect(prefs).toBeUndefined();
  });

  it('keeps the audit trail but unlinks it from the deleted person', async () => {
    const userId = await track('audited');
    const row = await db
      .insertInto('audit_log')
      .values({
        user_id: userId,
        action: 'auth.login',
        resource_type: 'auth',
        resource_id: userId,
        summary: 'Signed in before deletion',
        success: true,
        metadata: JSON.stringify({}),
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await accountDeletionService.delete(userId);

    // The event survives — that is the tamper-evidence promise — with the subject removed, which is
    // the erasure promise. Both, or the product is lying about one of them.
    const after = await db
      .selectFrom('audit_log')
      .select(['user_id', 'summary'])
      .where('id', '=', row.id)
      .executeTakeFirstOrThrow();
    expect(after.user_id).toBeNull();
    expect(after.summary).toBe('Signed in before deletion');
  });

  it('records the deletion itself as an audit event that outlives its subject', async () => {
    const userId = await track('self-audited');
    await accountDeletionService.delete(userId);

    const rows = await db
      .selectFrom('audit_log')
      .select(['action', 'resource_id', 'user_id'])
      .where('action', '=', 'delete')
      .where('resource_id', '=', userId)
      .execute();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBeNull();
  });

  it('purges vault secrets that no foreign key would have reached', async () => {
    const userId = await track('vaulted');
    const ref = await vault.put('a-refresh-token-that-must-not-survive');

    await db
      .insertInto('connections')
      .values({
        user_id: userId,
        provider: 'google',
        account_email: `vaulted-${randomUUID()}@stewra.invalid`,
        vault_ref: ref,
        status: 'active',
        scopes: '',
      })
      .execute();

    // Precondition: the secret is really there, so a passing assertion below cannot be vacuous.
    const before = await db
      .selectFrom('vault_secrets')
      .select('id')
      .where('id', '=', ref)
      .executeTakeFirst();
    expect(before).toBeDefined();

    const result = await accountDeletionService.delete(userId);

    expect(result.vaultSecretsDeleted).toBeGreaterThanOrEqual(1);
    const after = await db
      .selectFrom('vault_secrets')
      .select('id')
      .where('id', '=', ref)
      .executeTakeFirst();
    expect(after).toBeUndefined();
  });

  it('deletes a user who created an organization (the RESTRICT that used to forbid it)', async () => {
    const userId = await track('founder');
    const orgId = await makeOrg(userId);

    await accountDeletionService.delete(userId);

    expect(await userExists(userId)).toBe(false);
    // Sole member, so the org went with them rather than being left ownerless.
    const org = await db
      .selectFrom('organizations')
      .select('id')
      .where('id', '=', orgId)
      .executeTakeFirst();
    expect(org).toBeUndefined();
  });

  it('leaves an organization standing when other members remain, and releases the provenance', async () => {
    const founderId = await track('leaving-founder');
    const otherId = await track('remaining-owner');
    const orgId = await makeOrg(founderId);
    await db
      .insertInto('org_members')
      .values({ org_id: orgId, user_id: otherId, role: 'owner' })
      .execute();

    await accountDeletionService.delete(founderId);

    const org = await db
      .selectFrom('organizations')
      .select(['id', 'created_by'])
      .where('id', '=', orgId)
      .executeTakeFirst();
    expect(org).toBeDefined();
    // The founder's name came off; the organization did not go with them. This is exactly what
    // migration 038's own comment said should happen and what its constraint prevented.
    expect(org?.created_by).toBeNull();

    await db.deleteFrom('organizations').where('id', '=', orgId).execute();
  });

  it('refuses to delete the sole owner of an org that still has other members', async () => {
    const ownerId = await track('sole-owner');
    const memberId = await track('stranded-member');
    const orgId = await makeOrg(ownerId);
    await db
      .insertInto('org_members')
      .values({ org_id: orgId, user_id: memberId, role: 'agent' })
      .execute();

    const preview = await accountDeletionService.preview(ownerId);
    expect(preview.blockers).toHaveLength(1);
    expect(preview.blockers[0]?.kind).toBe('sole_owner');

    await expect(accountDeletionService.delete(ownerId)).rejects.toBeInstanceOf(ConflictError);
    // Refused means refused: the account is still there to try again after transferring ownership.
    expect(await userExists(ownerId)).toBe(true);

    await db.deleteFrom('organizations').where('id', '=', orgId).execute();
  });

  it('does not destroy a shared conversation just because the deleted user started it', async () => {
    const creatorId = await track('thread-creator');
    const otherId = await track('thread-survivor');

    const conversation = await db
      .insertInto('conversations')
      .values({ type: 'group', title: 'Shared thread', created_by: creatorId })
      .returning('id')
      .executeTakeFirstOrThrow();
    for (const userId of [creatorId, otherId]) {
      await db
        .insertInto('conversation_participants')
        .values({ conversation_id: conversation.id, user_id: userId, role: 'member' })
        .execute();
    }
    const message = await db
      .insertInto('messages')
      .values({
        conversation_id: conversation.id,
        sender_id: creatorId,
        sender_kind: 'user',
        message_type: 'text',
        content: 'still here after they left',
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await accountDeletionService.delete(creatorId);

    // The thread belongs to the people in it, not to whoever tapped "new group".
    const survivingThread = await db
      .selectFrom('conversations')
      .select(['id', 'created_by'])
      .where('id', '=', conversation.id)
      .executeTakeFirst();
    expect(survivingThread).toBeDefined();
    expect(survivingThread?.created_by).toBeNull();

    // And the history stays readable, with the sender unlinked — what `016_messages` always intended
    // and what the conversation cascade was silently overriding.
    const survivingMessage = await db
      .selectFrom('messages')
      .select(['id', 'sender_id', 'content'])
      .where('id', '=', message.id)
      .executeTakeFirst();
    expect(survivingMessage).toBeDefined();
    expect(survivingMessage?.sender_id).toBeNull();
    expect(survivingMessage?.content).toBe('still here after they left');

    await db.deleteFrom('conversations').where('id', '=', conversation.id).execute();
  });

  it('deletes a conversation nobody is left in', async () => {
    const userId = await track('solo-thread');
    const conversation = await db
      .insertInto('conversations')
      .values({ type: 'stewra_ai', created_by: userId })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('conversation_participants')
      .values({ conversation_id: conversation.id, user_id: userId, role: 'member' })
      .execute();

    await accountDeletionService.delete(userId);

    // Otherwise it would linger forever with no participants and no way to reach it.
    const after = await db
      .selectFrom('conversations')
      .select('id')
      .where('id', '=', conversation.id)
      .executeTakeFirst();
    expect(after).toBeUndefined();
  });
});
