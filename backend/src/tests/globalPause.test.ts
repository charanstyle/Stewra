import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import { db, closeDb } from '../database/index.js';
import { connectionRepository } from '../repositories/connectionRepository.js';
import { preferencesService } from '../services/preferencesService.js';
import { policyEngine } from '../control-plane/policy/policy.js';

/**
 * The global pause (build-plan M5): "stop everything" that is instant and obvious. The claim under
 * test is enforcement, not storage — a paused user's brokered reads are DENIED at the policy engine,
 * the single choke point every data read passes through, even though their connections are still
 * active; and resuming restores exactly what pausing removed. Flipping the switch lands in the
 * append-only audit log as its own `pause`/`resume` actions, and re-saving the same value writes no
 * duplicate row.
 *
 * Real Postgres, because the policy engine and the audit trigger are both database behavior.
 *
 * ⚠️ This suite deliberately does NOT delete its user: pausing writes an audit row, and
 * `audit_log.user_id` is ON DELETE SET NULL — an UPDATE the append-only trigger rejects (documented
 * in emailProposalGate.test.ts). Connections are cleaned up; the user row stays.
 */

const PASSWORD_HASH = await bcrypt.hash(randomUUID(), 10);

let userId = '';
const createdConnections: string[] = [];

beforeAll(async () => {
  const user = await db
    .insertInto('users')
    .values({
      email: `global-pause-${randomUUID()}@stewra.invalid`,
      display_name: 'Global Pause Test User',
      password_hash: PASSWORD_HASH,
      role: 'user',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  userId = user.id;

  // An ACTIVE calendar-authorizing connection, so any denial below is the pause and nothing else.
  const connection = await connectionRepository.upsert(
    userId,
    'google',
    'pause-test@example.com',
    `vault-ref-does-not-exist-${randomUUID()}`,
    ['https://www.googleapis.com/auth/calendar.readonly'],
  );
  createdConnections.push(connection.id);
});

afterAll(async () => {
  for (const id of createdConnections) {
    await db.deleteFrom('connections').where('id', '=', id).execute();
  }
  await closeDb();
});

describe('global pause', () => {
  it('defaults to running: pauseAll resolves false and policy allows the connected read', async () => {
    const prefs = await preferencesService.getForUser(userId);
    expect(prefs.pauseAll).toBe(false);

    const decision = await policyEngine.canRead(userId, 'calendar');
    expect(decision.allowed).toBe(true);
  });

  it('pausing denies every brokered read despite the active connection, and is audited', async () => {
    const prefs = await preferencesService.update(userId, { pauseAll: true });
    expect(prefs.pauseAll).toBe(true);

    // The connection is still active — only the pause stands between the user and the read.
    const calendar = await policyEngine.canRead(userId, 'calendar');
    expect(calendar.allowed).toBe(false);
    expect(calendar.reason).toContain('paused');
    // Every kind, not just the connected one: paused means nothing is readable.
    const money = await policyEngine.canRead(userId, 'money');
    expect(money.allowed).toBe(false);
    expect(money.reason).toContain('paused');

    const audits = await db
      .selectFrom('audit_log')
      .select(['action', 'success'])
      .where('user_id', '=', userId)
      .where('action', '=', 'pause')
      .execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.success).toBe(true);
  });

  it('re-saving the same value writes no duplicate audit row', async () => {
    await preferencesService.update(userId, { pauseAll: true });
    const audits = await db
      .selectFrom('audit_log')
      .select('id')
      .where('user_id', '=', userId)
      .where('action', '=', 'pause')
      .execute();
    expect(audits).toHaveLength(1);
  });

  it('resuming restores the read and audits the resume', async () => {
    const prefs = await preferencesService.update(userId, { pauseAll: false });
    expect(prefs.pauseAll).toBe(false);

    const decision = await policyEngine.canRead(userId, 'calendar');
    expect(decision.allowed).toBe(true);

    const audits = await db
      .selectFrom('audit_log')
      .select('id')
      .where('user_id', '=', userId)
      .where('action', '=', 'resume')
      .execute();
    expect(audits).toHaveLength(1);
  });
});
