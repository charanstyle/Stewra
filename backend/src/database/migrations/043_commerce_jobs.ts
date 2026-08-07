import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { Database } from '../types.js';

/**
 * The commerce plane's durable job queue.
 *
 * Postgres rather than Redis, deliberately. A scheduled send is a promise made to a client about a
 * message that will go to a member of the public at a particular time; it belongs in the same
 * database, the same backup, and the same transaction as the campaign row that promised it. Redis is
 * already deployed and would be faster, but a queue living outside Postgres is a queue living outside
 * `org_id` — nothing in `.dependency-cruiser.cjs` or `requireOrgMember` reaches into it, and a flush
 * would lose work whose only evidence was in it. At the volumes this platform will see for a long
 * while, `FOR UPDATE SKIP LOCKED` is not the bottleneck.
 *
 * What this replaces: `scheduler/scheduler.ts` and `commerce/scheduler/commerceScheduler.ts` are bare
 * `setInterval` loops. Work either succeeds on the tick or is lost until the next one — no record
 * that it was attempted, no backoff, no ceiling, and no way to see what failed. That is survivable
 * for a Gmail poll, which will simply try again in an hour and lose nothing. It is not survivable for
 * a campaign send, where "we tried, it 500'd, we forgot" is a message a client believes went out.
 *
 * Four states, and the distinction between the last two is the point:
 *
 *   `queued`  — waiting for `run_after`. Also where a failed-but-retryable attempt goes back to.
 *   `running` — leased by a worker until `locked_until`.
 *   `done`    — succeeded.
 *   `failed`  — failed for a reason retrying cannot fix, and so was never retried.
 *   `dead`    — exhausted `max_attempts`.
 *
 * `failed` exists separately from `dead` because retrying is not always neutral. A send refused
 * because the contact is on the suppression list must NOT be attempted four more times — every retry
 * is another attempt to message someone who asked to be left alone. The handler says which kind of
 * failure it hit; the queue believes it.
 *
 * Nothing is ever deleted on failure. A dead job is the only remaining evidence that something a
 * client was told would happen did not, and a queue that tidies those away is a queue that reports
 * itself healthy while the work is gone.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  await db.schema
    .createTable('commerce_jobs')
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    // Every job belongs to a tenant, including ones enqueued by a sweep rather than by a request.
    // There is no such thing as an org-less job in this plane: a job with no owner is a job no
    // tenancy check applies to, and the handler for it would be reaching across orgs by definition.
    .addColumn('org_id', 'uuid', (col) =>
      col.notNull().references('organizations.id').onDelete('cascade'),
    )
    .addColumn('kind', 'varchar(64)', (col) => col.notNull())
    // The handler's input, verbatim. Deliberately opaque to the queue — a job table that understands
    // its payloads acquires a column per feature and stops being a queue.
    //
    // Constrained to a JSON *object* rather than any JSON value. `jsonb` would happily accept the
    // number 3, and the row that held it would then break the batch it was claimed in rather than
    // just itself. Refusing it at the column means the enqueuer that wrote it fails, at the moment
    // it wrote it, instead of a worker discovering it an hour later on someone else's behalf.
    .addColumn('payload', 'jsonb', (col) =>
      col.notNull().check(sql`jsonb_typeof(payload) = 'object'`),
    )
    .addColumn('status', 'varchar(16)', (col) =>
      col
        .notNull()
        .defaultTo('queued')
        .check(sql`status in ('queued', 'running', 'done', 'failed', 'dead')`),
    )
    // When this becomes eligible. Both the schedule (a broadcast at 09:00) and the backoff (retry in
    // 4s, then 16s) are the same column, because they are the same question.
    .addColumn('run_after', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('max_attempts', 'integer', (col) => col.notNull().defaultTo(5))
    // Why the last attempt failed, in the handler's own words. Kept on a job that later succeeds:
    // "it worked on the fourth try" is worth knowing, and clearing it would hide a flaky dependency.
    .addColumn('last_error', 'text')
    // The lease. A worker that is killed mid-job cannot release its claim, so the claim has to expire
    // on its own — `locked_until` in the past means the job is available again, no matter what
    // `locked_by` says. Without this a single crashed process strands its in-flight jobs forever.
    .addColumn('locked_by', 'varchar(128)')
    .addColumn('locked_until', 'timestamptz')
    // Idempotency, supplied by the enqueuer. `broadcast:<campaignId>:<contactId>` means the same
    // person cannot be sent the same campaign twice however many times the enqueueing sweep runs.
    // Unique across ALL states rather than only live ones: the duplicate that matters most is the one
    // enqueued after the first already sent.
    .addColumn('dedupe_key', 'varchar(200)')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    // Set once the job reaches a terminal state, so "how long did this sit" is answerable in SQL.
    .addColumn('finished_at', 'timestamptz')
    .execute();

  // The claim query's index. Partial on the two states a worker ever looks for, so the scan never
  // walks the millions of `done` rows a busy tenant accumulates.
  await sql`
    CREATE INDEX idx_commerce_jobs_claimable
    ON commerce_jobs (run_after, created_at)
    WHERE status in ('queued', 'running')
  `.execute(db);

  // Idempotency. Partial because the column is nullable and most jobs have no natural key — a plain
  // unique index would collapse every NULL-keyed job into... nothing, actually (NULLs don't collide
  // in Postgres), but stating the intent here keeps the index off rows it can never match.
  await sql`
    CREATE UNIQUE INDEX uq_commerce_jobs_dedupe
    ON commerce_jobs (org_id, dedupe_key)
    WHERE dedupe_key IS NOT NULL
  `.execute(db);

  // The operator's view: "what is wrong in this tenant right now".
  await db.schema
    .createIndex('idx_commerce_jobs_org_status')
    .on('commerce_jobs')
    .columns(['org_id', 'status', 'created_at'])
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('commerce_jobs').ifExists().execute();
}
