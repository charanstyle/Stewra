import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';

process.env['RUNNER_ENABLED'] = 'true';
process.env['RUNNER_DOWNLOAD_URL'] = 'https://downloads.example.test/stewra-runner';
process.env['RUNNER_MIN_VERSION'] = '0.2.0';
process.env['RUNNER_LATEST_VERSION'] = '0.2.0';

const { db, closeDb } = await import('../database/index.js');
const { organizationRepository } = await import('../tenancy/repositories/organizationRepository.js');
const { runnerDeviceRepository } = await import('../repositories/runnerDeviceRepository.js');
const { runnerSessionRepository } = await import('../repositories/runnerSessionRepository.js');
const { RunnerChatRelayService } = await import('../services/runnerChatRelayService.js');

/**
 * The chat relay's memory is on disk (migration 066). What this proves is the one property that
 * matters: a relay target and a pending permission registered by ONE instance of the service are
 * visible to a DIFFERENT instance — which is what a restarted backend is. Real Postgres, real rows.
 */
const PASSWORD_HASH = await bcrypt.hash(randomUUID(), 10);
const createdUsers: string[] = [];
const createdOrgs: string[] = [];

async function setUp(): Promise<{ userId: string; conversationId: string; sessionId: string }> {
  const user = await db
    .insertInto('users')
    .values({
      email: `relay-${randomUUID()}@stewra.invalid`,
      display_name: 'Relay Test User',
      password_hash: PASSWORD_HASH,
      role: 'user',
      email_verified: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  createdUsers.push(user.id);
  const { org } = await organizationRepository.create({
    name: 'Relay Test Org',
    slug: `relay-${randomUUID().slice(0, 8)}`,
    kind: 'individual',
    createdBy: user.id,
  });
  createdOrgs.push(org.id);
  const { device } = await runnerDeviceRepository.registerDevice({
    orgId: org.id,
    userId: user.id,
    name: 'Mac mini',
    appVersion: '0.2.0',
    os: 'darwin',
  });
  const session = await runnerSessionRepository.create({
    orgId: org.id,
    userId: user.id,
    deviceId: device.id,
    deviceName: device.name,
    projectId: null,
    projectName: null,
    harness: 'claude-code',
    workspaceId: 'ws_truetalk',
    workspaceName: 'product_advisor',
    prompt: 'run the tests',
    status: 'running',
  });
  const conversation = await db
    .insertInto('conversations')
    .values({ type: 'stewra_ai', created_by: user.id })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { userId: user.id, conversationId: conversation.id, sessionId: session.id };
}

/** What the origin conversation's thread says, oldest first — straight from the table. */
async function contentsOf(conversationId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('messages')
    .select('content')
    .where('conversation_id', '=', conversationId)
    .orderBy('created_at', 'asc')
    .execute();
  return rows.map((r) => r.content ?? '');
}

afterAll(async () => {
  if (createdOrgs.length > 0) {
    await db.deleteFrom('org_members').where('org_id', 'in', createdOrgs).execute();
    await db.deleteFrom('organizations').where('id', 'in', createdOrgs).execute();
  }
  if (createdUsers.length > 0) {
    await db.deleteFrom('conversations').where('created_by', 'in', createdUsers).execute();
    await db
      .deleteFrom('users')
      .where('id', 'in', createdUsers)
      .where(({ not, exists, selectFrom }) =>
        not(exists(selectFrom('audit_log').select('id').whereRef('audit_log.user_id', '=', 'users.id'))),
      )
      .execute();
  }
  await closeDb();
});

describe('the chat relay survives a restart', () => {
  it('answers a permission registered by a previous process, and posts the gate into the origin chat', async () => {
    const { userId, conversationId, sessionId } = await setUp();

    // Process one: the session was started from a chat.
    const before = new RunnerChatRelayService();
    await before.registerOrigin(sessionId, {
      userId,
      conversationId,
      channel: 'stewra_chat',
      deviceName: 'Mac mini',
      workspaceName: 'product_advisor',
      projectName: 'Truetalk',
    });

    // Process two: the backend restarted; the runner now hits a gate.
    const after = new RunnerChatRelayService();
    await after.onPermission(userId, {
      sessionId,
      promptId: 'perm-1',
      title: 'Run npm test',
      detail: 'npm test',
      options: [
        { id: 'allow', label: 'Allow', kind: 'allow_once' },
        { id: 'deny', label: 'Deny', kind: 'reject_once' },
      ],
    });

    const pending = await after.latestPendingPermission(userId);
    expect(pending).toEqual({
      userId,
      sessionId,
      promptId: 'perm-1',
      allowOptionId: 'allow',
      denyOptionId: 'deny',
      title: 'Run npm test',
    });

    // The ask reached the chat the session came from — names the PROJECT, not the folder, and asks the
    // way a person would.
    const gate = (await contentsOf(conversationId)).find((c) => c.includes('needs your OK'));
    expect(gate).toBe('Truetalk needs your OK for one step: Run npm test — npm test. Shall I let it? (yes / no)');

    // Answered → forgotten. Done → origin forgotten, result posted.
    await after.clearPermission(sessionId);
    await expect(after.latestPendingPermission(userId)).resolves.toBeNull();

    // The runner's "stopReason: end_turn" is its ordinary ending and is not repeated to the person.
    await new RunnerChatRelayService().onDone({
      sessionId,
      status: 'completed',
      summary: 'stopReason: end_turn',
      branch: 'stewra/run/x',
      committed: true,
    });
    expect(await contentsOf(conversationId)).toContain(
      'All done — Truetalk on Mac mini has finished. The changes are saved on branch stewra/run/x. Say "push it" and I\'ll push them, or "open a PR".',
    );
    const origin = await db.selectFrom('runner_chat_origins').selectAll().where('session_id', '=', sessionId).executeTakeFirst();
    expect(origin).toBeUndefined();
  });
});
