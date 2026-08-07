import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { sql } from 'kysely';
import { db, closeDb } from '../database/index.js';

/**
 * The append-only guarantee, and the one hole deliberately left in it.
 *
 * `002_audit_log` refused every UPDATE and DELETE, which read as maximally strict and was in one way
 * too strict to work: `audit_log.user_id` is ON DELETE SET NULL, SET NULL is an UPDATE, so deleting a
 * user with any audit row raised. A login writes one, so that was every user — account deletion could
 * not happen at all, and the failure surfaced only at the DELETE.
 *
 * `047_audit_log_erasure` permits exactly one write: clearing `user_id` on a row that had one. This
 * suite exists to keep that hole exactly one hole wide. Every assertion below is about a claim the
 * product makes out loud — the log is tamper-evident, and a person can really be removed — so a
 * regression in either direction has to fail here rather than in an erasure request.
 *
 * Real Postgres, necessarily: the enforcement IS the trigger. There is nothing in TypeScript to test.
 */

const PASSWORD_HASH = await bcrypt.hash(randomUUID(), 10);

/** A user with one audit row — the state that used to be undeletable. */
async function userWithAuditRow(): Promise<{ userId: string; rowId: string }> {
  const user = await db
    .insertInto('users')
    .values({
      email: `audit-append-${randomUUID()}@stewra.invalid`,
      display_name: 'Audit Append-Only Test User',
      password_hash: PASSWORD_HASH,
      role: 'user',
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  const row = await db
    .insertInto('audit_log')
    .values({
      user_id: user.id,
      action: 'auth.login',
      resource_type: 'auth',
      resource_id: null,
      summary: 'Signed in',
      success: true,
      metadata: JSON.stringify({}),
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return { userId: user.id, rowId: row.id };
}

afterAll(async () => {
  await closeDb();
});

describe('audit_log append-only', () => {
  it('refuses to rewrite what an event says', async () => {
    const { rowId } = await userWithAuditRow();

    // The whole point of the table. If this ever succeeds, the log is no longer evidence of anything.
    await expect(
      db.updateTable('audit_log').set({ summary: 'Did nothing at all' }).where('id', '=', rowId).execute(),
    ).rejects.toThrow(/append-only/);
  });

  it('refuses to delete an event', async () => {
    const { rowId } = await userWithAuditRow();

    await expect(
      db.deleteFrom('audit_log').where('id', '=', rowId).execute(),
    ).rejects.toThrow(/DELETE is not permitted/);
  });

  it('refuses an erasure that smuggles an edit alongside it', async () => {
    const { rowId } = await userWithAuditRow();

    // Nulling user_id is allowed; nulling it WHILE rewriting the summary is not. Comparing every
    // column is what keeps the exception from becoming a general-purpose write.
    await expect(
      db
        .updateTable('audit_log')
        .set({ user_id: null, summary: 'Something else entirely' })
        .where('id', '=', rowId)
        .execute(),
    ).rejects.toThrow(/append-only/);
  });

  it('refuses to reassign an event to a different person', async () => {
    const { rowId } = await userWithAuditRow();
    const other = await userWithAuditRow();

    // Only non-null -> NULL is permitted. Moving a row onto someone else would let the log say a
    // different person did the thing, which is worse than deleting it.
    await expect(
      db.updateTable('audit_log').set({ user_id: other.userId }).where('id', '=', rowId).execute(),
    ).rejects.toThrow(/append-only/);
  });

  it('lets a user be deleted, unlinking their events without erasing them', async () => {
    const { userId, rowId } = await userWithAuditRow();

    await db.deleteFrom('users').where('id', '=', userId).execute();

    const row = await db
      .selectFrom('audit_log')
      .select(['user_id', 'summary', 'action'])
      .where('id', '=', rowId)
      .executeTakeFirstOrThrow();

    // The person is gone from the row; the event itself is untouched. That is the trade: erasure
    // removes the subject, not the history.
    expect(row.user_id).toBeNull();
    expect(row.summary).toBe('Signed in');
    expect(row.action).toBe('auth.login');
  });

  it('still refuses to touch a row once it has been anonymised', async () => {
    const { userId, rowId } = await userWithAuditRow();
    await db.deleteFrom('users').where('id', '=', userId).execute();

    // NULL -> NULL is not "non-null -> NULL", so an already-erased row is fully frozen again. Without
    // this, the exception would stay open forever on every anonymised row.
    await expect(
      db.updateTable('audit_log').set({ summary: 'Rewritten later' }).where('id', '=', rowId).execute(),
    ).rejects.toThrow(/append-only/);
  });

  it('has the trigger installed at all', async () => {
    // Cheap canary: a dropped trigger would make every assertion above pass for the wrong reason,
    // since an unguarded table accepts updates silently.
    const result = await sql<{ count: string }>`
      SELECT count(*)::text AS count
      FROM pg_trigger
      WHERE tgname = 'trg_audit_log_append_only' AND NOT tgisinternal
    `.execute(db);

    expect(result.rows[0]?.count).toBe('1');
  });
});
