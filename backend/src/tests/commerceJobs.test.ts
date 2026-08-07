import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import bcrypt from 'bcryptjs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db, closeDb } from '../database/index.js';
import { organizationRepository } from '../commerce/repositories/organizationRepository.js';
import { jobRepository } from '../commerce/repositories/jobRepository.js';
import { channelAccountRepository } from '../commerce/repositories/channelAccountRepository.js';
import { commerceWorker } from '../commerce/jobs/worker.js';
import { vault } from '../control-plane/vault/vault.js';

/**
 * THE JOB QUEUE.
 *
 * What this suite exists to pin down is not "does work run" — a `setInterval` did that. It is the
 * four things a timer could not do, each of which is the difference between a campaign send that a
 * client can rely on and one they merely hope happened:
 *
 *  - **A failure is retried, with the wait growing each time.** Not immediately, not forever.
 *  - **Giving up is bounded, recorded, and visible.** A job that ran out of attempts is `dead` in a
 *    table, not a log line from four hours ago.
 *  - **Some failures must NOT be retried.** Retrying a send the consent gate refused is another
 *    attempt to message someone who asked to be left alone, so a handler can say "stop" and be
 *    obeyed — separately from having run out of tries.
 *  - **A worker that dies does not take its work with it.** The lease expires and another worker
 *    picks the job up, which is the only reason a `kill -9` mid-deploy is survivable.
 *
 * Nothing is stood in for. Real `stewra_test` Postgres, the real `FOR UPDATE SKIP LOCKED` claim, the
 * real worker loop driven one pass at a time, and the real `channel_token_refresh` handler. That
 * handler fails here for an honest reason rather than an arranged one: `META_COMMERCE_ENABLED` is
 * false in `.env.test`, so the Graph call it makes throws exactly as it would against an unreachable
 * Meta — which is the transient class the retry ladder exists for.
 */

const PASSWORD_HASH = await bcrypt.hash(randomUUID(), 10);
const createdOrgs: string[] = [];
const createdUsers: string[] = [];
const createdSecrets: string[] = [];

async function createOrg(): Promise<string> {
  const email = `commerce-jobs-${randomUUID()}@stewra.invalid`;
  const user = await db
    .insertInto('users')
    .values({
      email,
      display_name: 'Commerce Jobs Test User',
      password_hash: PASSWORD_HASH,
      role: 'user',
      email_verified: true,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  createdUsers.push(user.id);

  const { org } = await organizationRepository.create({
    name: 'Jobs Test Org',
    slug: `jobs-${randomUUID().slice(0, 12)}`,
    createdBy: user.id,
  });
  createdOrgs.push(org.id);
  return org.id;
}

/** A connected WhatsApp account with a real vaulted credential, so the handler has something to find. */
async function connectedAccount(orgId: string, expiresAt: Date): Promise<string> {
  const credentialRef = await vault.put(`test-token-${randomUUID()}`);
  createdSecrets.push(credentialRef);
  const { account } = await channelAccountRepository.upsert({
    orgId,
    platform: 'whatsapp_cloud',
    externalAccountId: `waba-${randomUUID().slice(0, 12)}`,
    phoneNumberId: `pn-${randomUUID().slice(0, 12)}`,
    displayName: 'Jobs Test Number',
    displayPhoneNumber: null,
    credentialRef,
    credentialExpiresAt: expiresAt,
    meta: {},
  });
  return account.id;
}

/** The status and bookkeeping of one job, read straight from the table rather than through a mapper. */
async function stateOf(jobId: string): Promise<{
  status: string;
  attempts: number;
  lastError: string | null;
  runAfter: Date;
  lockedBy: string | null;
  finishedAt: Date | null;
}> {
  const row = await db
    .selectFrom('commerce_jobs')
    .selectAll()
    .where('id', '=', jobId)
    .executeTakeFirstOrThrow();
  return {
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    runAfter: row.run_after,
    lockedBy: row.locked_by,
    finishedAt: row.finished_at,
  };
}

/**
 * Run the worker until a specific job stops being claimable, defeating the backoff between passes.
 *
 * The backoff is real — after the first failure the job is not due for four seconds — and a test that
 * honoured it would take twenty minutes to reach the fifth attempt. Rewriting `run_after` to now is
 * the only thing forced here; every other part of the ladder (which status, how many attempts, when
 * it dies) is whatever the worker actually decided.
 */
async function runUntilTerminal(jobId: string, maxPasses = 12): Promise<void> {
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const before = await stateOf(jobId);
    if (before.status !== 'queued' && before.status !== 'running') return;
    await db
      .updateTable('commerce_jobs')
      .set({ run_after: new Date(Date.now() - 1000) })
      .where('id', '=', jobId)
      .execute();
    await commerceWorker.runOnce();
  }
  throw new Error(`job ${jobId} never reached a terminal state`);
}

beforeAll(async () => {
  // Other suites share this database and leave their own jobs behind. The worker's claim is global
  // by design, so a pass here would run them — and their handlers would fail for reasons that have
  // nothing to do with what is being asserted. Clearing first makes each `runOnce` mean what it says.
  await db.deleteFrom('commerce_jobs').execute();
});

afterAll(async () => {
  await db.deleteFrom('commerce_jobs').where('org_id', 'in', createdOrgs).execute();
  for (const ref of createdSecrets) {
    await vault.delete(ref);
  }
  if (createdOrgs.length > 0) {
    await db.deleteFrom('organizations').where('id', 'in', createdOrgs).execute();
  }
  if (createdUsers.length > 0) {
    await db.deleteFrom('users').where('id', 'in', createdUsers).execute();
  }
  await closeDb();
});

// ---------------------------------------------------------------------------------------------

describe('claiming', () => {
  it('claims a job that is due and leaves one that is not', async () => {
    const orgId = await createOrg();
    const due = await jobRepository.enqueue({
      orgId,
      kind: 'channel_token_refresh',
      payload: { channelAccountId: randomUUID() },
    });
    const later = await jobRepository.enqueue({
      orgId,
      kind: 'channel_token_refresh',
      payload: { channelAccountId: randomUUID() },
      runAfter: new Date(Date.now() + 60 * 60 * 1000),
    });
    expect(due).not.toBeNull();
    expect(later).not.toBeNull();

    const claimed = await jobRepository.claim('test-worker', 300, 10);
    const ids = claimed.map((j) => j.id);
    expect(ids).toContain(due?.id);
    // A scheduled broadcast that ran an hour early is worse than one that ran a minute late.
    expect(ids).not.toContain(later?.id);
  });

  it('never hands the same job to two workers', async () => {
    const orgId = await createOrg();
    const job = await jobRepository.enqueue({
      orgId,
      kind: 'channel_token_refresh',
      payload: { channelAccountId: randomUUID() },
    });

    // Both claims race for the same row. `FOR UPDATE SKIP LOCKED` is what makes the loser step over
    // it rather than block on it — without that, two workers double-send every campaign message.
    const [first, second] = await Promise.all([
      jobRepository.claim('worker-a', 300, 10),
      jobRepository.claim('worker-b', 300, 10),
    ]);
    const holders = [...first, ...second].filter((j) => j.id === job?.id);
    expect(holders).toHaveLength(1);
  });

  it('increments attempts on the claim, not on the failure', async () => {
    const orgId = await createOrg();
    const job = await jobRepository.enqueue({
      orgId,
      kind: 'channel_token_refresh',
      payload: { channelAccountId: randomUUID() },
    });

    await jobRepository.claim('test-worker', 300, 10);

    // Counting claims rather than failures is what bounds a job that CRASHES its worker: such a job
    // never reaches a failure handler, so a failure-counted attempt would let it be reclaimed and
    // crash the next worker, forever.
    expect((await stateOf(job?.id ?? '')).attempts).toBe(1);
  });

  it('reclaims a job whose worker died, and leaves a live lease alone', async () => {
    const orgId = await createOrg();
    const abandoned = await jobRepository.enqueue({
      orgId,
      kind: 'channel_token_refresh',
      payload: { channelAccountId: randomUUID() },
    });
    const held = await jobRepository.enqueue({
      orgId,
      kind: 'channel_token_refresh',
      payload: { channelAccountId: randomUUID() },
    });

    await jobRepository.claim('worker-that-will-die', 300, 10);
    // Standing in for the passage of time, not for a component: the lease on one job has run out
    // while the other's has not. A worker killed mid-job cannot release its own claim, so expiry is
    // the only mechanism that can ever free it.
    await db
      .updateTable('commerce_jobs')
      .set({ locked_until: new Date(Date.now() - 1000) })
      .where('id', '=', abandoned?.id ?? '')
      .execute();

    const reclaimed = await jobRepository.claim('worker-b', 300, 10);
    const ids = reclaimed.map((j) => j.id);
    expect(ids).toContain(abandoned?.id);
    expect(ids).not.toContain(held?.id);
  });
});

describe('retrying', () => {
  it('backs off further on each attempt and gives up at the ceiling', async () => {
    const orgId = await createOrg();
    const accountId = await connectedAccount(orgId, new Date(Date.now() + 3 * 24 * 60 * 60 * 1000));
    const job = await jobRepository.enqueue({
      orgId,
      kind: 'channel_token_refresh',
      payload: { channelAccountId: accountId },
      maxAttempts: 3,
    });
    const jobId = job?.id ?? '';

    // First failure: the Graph call cannot be made, which is a transient class of fault, so the job
    // goes back on the queue rather than being abandoned.
    await commerceWorker.runOnce();
    const first = await stateOf(jobId);
    expect(first.status).toBe('queued');
    expect(first.attempts).toBe(1);
    expect(first.lastError).not.toBeNull();
    expect(first.runAfter.getTime()).toBeGreaterThan(Date.now());
    // The lease is released on the way out — a queued job holding a lock would be invisible to the
    // claim that is supposed to pick it up again.
    expect(first.lockedBy).toBeNull();

    // Each retry waits longer than the last. Retrying a Graph outage at a fixed interval is just a
    // slower version of hammering it.
    const firstDelay = first.runAfter.getTime() - Date.now();
    await db
      .updateTable('commerce_jobs')
      .set({ run_after: new Date(Date.now() - 1000) })
      .where('id', '=', jobId)
      .execute();
    await commerceWorker.runOnce();
    const second = await stateOf(jobId);
    expect(second.status).toBe('queued');
    expect(second.attempts).toBe(2);
    expect(second.runAfter.getTime() - Date.now()).toBeGreaterThan(firstDelay);

    // Third attempt is the last one `maxAttempts` allows.
    await runUntilTerminal(jobId);
    const final = await stateOf(jobId);
    expect(final.status).toBe('dead');
    expect(final.attempts).toBe(3);
    expect(final.finishedAt).not.toBeNull();
  });

  it('leaves a dead job in the table rather than tidying it away', async () => {
    const orgId = await createOrg();
    const accountId = await connectedAccount(orgId, new Date(Date.now() + 3 * 24 * 60 * 60 * 1000));
    const job = await jobRepository.enqueue({
      orgId,
      kind: 'channel_token_refresh',
      payload: { channelAccountId: accountId },
      maxAttempts: 1,
    });
    await runUntilTerminal(job?.id ?? '');

    // A dead job is the only remaining evidence that something a client was told would happen did
    // not. A queue that deletes them reports itself healthy while the work is gone.
    const found = await jobRepository.findById(orgId, job?.id ?? '');
    expect(found?.status).toBe('dead');
    expect(found?.lastError).not.toBeNull();
  });
});

describe('failing without retrying', () => {
  it('does not retry when the handler says retrying cannot help', async () => {
    const orgId = await createOrg();
    const job = await jobRepository.enqueue({
      orgId,
      kind: 'channel_token_refresh',
      // A well-formed id for an account that does not exist. Nothing about running this again in
      // four seconds makes it exist.
      payload: { channelAccountId: randomUUID() },
      maxAttempts: 5,
    });

    await commerceWorker.runOnce();

    const state = await stateOf(job?.id ?? '');
    expect(state.status).toBe('failed');
    // The distinction that matters: it stopped after ONE attempt, with four still available. When
    // this queue carries sends, this is the branch that stops a refusal from becoming four more
    // attempts to message someone who asked not to be.
    expect(state.attempts).toBe(1);
    expect(state.lastError).toContain('no longer exists');
  });

  it('fails a job whose payload this build cannot read', async () => {
    const orgId = await createOrg();
    const job = await jobRepository.enqueue({
      orgId,
      kind: 'channel_token_refresh',
      payload: { wrongField: 'nonsense' },
    });

    await commerceWorker.runOnce();

    const state = await stateOf(job?.id ?? '');
    expect(state.status).toBe('failed');
    // Named, so an operator reading the row knows which field. A `TypeError` from three calls deeper
    // would say only that something was undefined.
    expect(state.lastError).toContain('channelAccountId');
  });

  it('fails a job of a kind this build has no handler for', async () => {
    const orgId = await createOrg();
    // Written past the type, because that is exactly how it happens: a rollback meets jobs a newer
    // build enqueued. The column is a varchar and will hold anything.
    const inserted = await sql<{ id: string }>`
      INSERT INTO commerce_jobs (org_id, kind, payload)
      VALUES (${orgId}, 'campaign_send_from_the_future', '{}'::jsonb)
      RETURNING id
    `.execute(db);
    const jobId = inserted.rows[0]?.id ?? '';

    await commerceWorker.runOnce();

    const state = await stateOf(jobId);
    // Terminal rather than retried: no amount of waiting teaches this build the handler. And the
    // rest of the batch still ran — one unknown job must not stop the queue.
    expect(state.status).toBe('failed');
    expect(state.lastError).toContain('no handler registered');
  });

  it('refuses a payload that is not an object at the column', async () => {
    const orgId = await createOrg();
    // The constraint exists because this row would otherwise break the whole batch it was claimed
    // in, not just itself — the enqueuer that wrote it should be the one that fails.
    await expect(
      sql`INSERT INTO commerce_jobs (org_id, kind, payload)
          VALUES (${orgId}, 'channel_token_refresh', '3'::jsonb)`.execute(db),
    ).rejects.toThrow();
  });
});

describe('enqueueing the same work twice', () => {
  it('accepts it once per org and refuses the duplicate', async () => {
    const orgId = await createOrg();
    const key = `broadcast:${randomUUID()}`;

    const first = await jobRepository.enqueue({
      orgId,
      kind: 'channel_token_refresh',
      payload: { channelAccountId: randomUUID() },
      dedupeKey: key,
    });
    const second = await jobRepository.enqueue({
      orgId,
      kind: 'channel_token_refresh',
      payload: { channelAccountId: randomUUID() },
      dedupeKey: key,
    });

    expect(first).not.toBeNull();
    // Null rather than the existing job: an enqueuer that re-runs must not be handed someone else's
    // job to treat as the one it just created.
    expect(second).toBeNull();
  });

  it('still refuses the duplicate after the first one has finished', async () => {
    const orgId = await createOrg();
    const key = `broadcast:${randomUUID()}`;
    const first = await jobRepository.enqueue({
      orgId,
      kind: 'channel_token_refresh',
      payload: { channelAccountId: randomUUID() },
      dedupeKey: key,
    });
    await commerceWorker.runOnce();
    expect((await stateOf(first?.id ?? '')).status).toBe('failed');

    // The duplicate that matters most is the one enqueued AFTER the first already sent, which is why
    // the key is unique across every state rather than only the live ones.
    const again = await jobRepository.enqueue({
      orgId,
      kind: 'channel_token_refresh',
      payload: { channelAccountId: randomUUID() },
      dedupeKey: key,
    });
    expect(again).toBeNull();
  });

  it('lets a different org use the same key', async () => {
    const key = `broadcast:${randomUUID()}`;
    const orgA = await createOrg();
    const orgB = await createOrg();

    const a = await jobRepository.enqueue({
      orgId: orgA,
      kind: 'channel_token_refresh',
      payload: { channelAccountId: randomUUID() },
      dedupeKey: key,
    });
    const b = await jobRepository.enqueue({
      orgId: orgB,
      kind: 'channel_token_refresh',
      payload: { channelAccountId: randomUUID() },
      dedupeKey: key,
    });

    // Two tenants picking the same campaign name must not silence each other's work.
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });
});

describe('tenancy', () => {
  it('does not let one org read another org\'s job', async () => {
    const orgA = await createOrg();
    const orgB = await createOrg();
    const job = await jobRepository.enqueue({
      orgId: orgA,
      kind: 'channel_token_refresh',
      payload: { channelAccountId: randomUUID() },
    });

    expect(await jobRepository.findById(orgA, job?.id ?? '')).not.toBeNull();
    // The job carries its own org, and every read filters on it. `claim` is the single query in this
    // plane that crosses tenants, and it returns nothing that is not already stamped with its owner.
    expect(await jobRepository.findById(orgB, job?.id ?? '')).toBeNull();
  });

  it('counts every status for one org, including the ones at zero', async () => {
    const orgId = await createOrg();
    await jobRepository.enqueue({
      orgId,
      kind: 'channel_token_refresh',
      payload: { channelAccountId: randomUUID() },
    });

    const counts = await jobRepository.countsByStatus(orgId);
    expect(counts.queued).toBe(1);
    // Present and zero, not absent. A monitoring check asking "how many are dead?" must read the
    // answer directly — making it distinguish zero from a missing key is how one reports healthy.
    expect(counts.dead).toBe(0);
    expect(counts.failed).toBe(0);
    expect(counts.done).toBe(0);
  });

  it('lists only its own org\'s jobs, newest first', async () => {
    const orgA = await createOrg();
    const orgB = await createOrg();
    await jobRepository.enqueue({
      orgId: orgB,
      kind: 'channel_token_refresh',
      payload: { channelAccountId: randomUUID() },
    });
    const mine = await jobRepository.enqueue({
      orgId: orgA,
      kind: 'channel_token_refresh',
      payload: { channelAccountId: randomUUID() },
    });

    const listed = await jobRepository.listForOrg(orgA, 50);
    expect(listed.map((j) => j.id)).toEqual([mine?.id]);
  });
});
