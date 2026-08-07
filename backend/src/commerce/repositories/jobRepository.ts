import type { Selectable } from 'kysely';
import { sql } from 'kysely';
import type {
  CommerceJob,
  CommerceJobKind,
  CommerceJobStatus,
  JsonObject,
} from '@stewra/shared-types';
import { db } from '../../database/index.js';
import type { CommerceJobsTable } from '../../database/types.js';

/**
 * The selected row, named so the raw claim query can be typed against the same shape Kysely infers
 * for the ordinary selects. The claim is a CTE Kysely cannot express, so without this its result
 * would be untyped and the mapper would need an assertion to accept it.
 */
type JobRow = Selectable<CommerceJobsTable>;

/**
 * `payload` is `jsonb`, which at the type level could hold a bare number or a string. A predicate
 * rather than a cast: the check and the narrowing are the same statement, so the type cannot outrun
 * what was actually verified.
 */
function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toJob(row: JobRow): CommerceJob {
  // Unreachable in practice: migration 043 constrains the column to `jsonb_typeof(payload) =
  // 'object'`, so a non-object payload is refused at the INSERT rather than discovered here. Kept
  // because this mapper runs over a whole claimed batch — if the constraint were ever dropped, the
  // alternative to this line is one malformed row silently taking down four healthy jobs with it.
  if (!isJsonObject(row.payload)) {
    throw new Error(`commerce job ${row.id} has a payload that is not a JSON object`);
  }
  return {
    id: row.id,
    orgId: row.org_id,
    kind: row.kind,
    payload: row.payload,
    status: row.status,
    runAfter: row.run_after.toISOString(),
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lastError: row.last_error,
    lockedBy: row.locked_by,
    lockedUntil: row.locked_until === null ? null : row.locked_until.toISOString(),
    dedupeKey: row.dedupe_key,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    finishedAt: row.finished_at === null ? null : row.finished_at.toISOString(),
  };
}

/**
 * The durable job queue's data access (migration 043).
 *
 * Everything here is scoped by `org_id` EXCEPT `claim`, and that exception is deliberate rather than
 * an oversight: a worker serves every tenant, and an org-scoped claim would mean one loop per
 * organization. The tenancy guarantee is preserved one layer up instead — the job carries its own
 * `orgId`, and every handler is given that id and reaches its data through org-scoped repositories.
 * `claim` is the single place in the commerce plane where a query crosses tenants, and it returns
 * nothing but jobs already stamped with the tenant they belong to.
 */
class JobRepository {
  /**
   * Put work on the queue. Returns null when `dedupeKey` matched a job this org already has.
   *
   * Null rather than the existing row, and rather than an error. The enqueuer's question is "is this
   * work scheduled?", and the answer when it already is happens to be "yes, and not by you" — a
   * sweep that re-runs must be able to call this on every candidate without branching. Returning the
   * prior job would invite a caller to treat someone else's job as the one it just created.
   */
  async enqueue(params: {
    orgId: string;
    kind: CommerceJobKind;
    payload: JsonObject;
    runAfter?: Date;
    maxAttempts?: number;
    dedupeKey?: string;
  }): Promise<CommerceJob | null> {
    const row = await db
      .insertInto('commerce_jobs')
      .values({
        org_id: params.orgId,
        kind: params.kind,
        payload: JSON.stringify(params.payload),
        run_after: params.runAfter,
        max_attempts: params.maxAttempts,
        dedupe_key: params.dedupeKey,
      })
      .onConflict((oc) => oc.doNothing())
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? null : toJob(row);
  }

  /**
   * Take up to `limit` due jobs and lease them to `workerId`.
   *
   * `FOR UPDATE SKIP LOCKED` is what lets more than one worker run: a row another transaction is
   * already claiming is stepped over instead of waited on, so N workers divide the queue rather than
   * queueing behind each other.
   *
   * Two things here are load-bearing:
   *
   * 1. **`running` rows whose lease has expired are claimable again.** A worker killed mid-job cannot
   *    release its own claim, so the claim has to time out on its own. Without this a single `kill -9`
   *    strands whatever it held, permanently, in a state that looks like progress.
   *
   * 2. **`attempts` increments on CLAIM, not on failure.** A job that crashes the worker never
   *    reaches a failure handler, so counting failures would let it be reclaimed forever — one
   *    poisonous payload taking the process down on a loop. Counting claims means a job that kills
   *    its worker still runs out of attempts and lands in `dead`, where someone can see it.
   */
  async claim(workerId: string, leaseSeconds: number, limit: number): Promise<CommerceJob[]> {
    const result = await sql<JobRow>`
      WITH claimable AS (
        SELECT id
        FROM commerce_jobs
        WHERE run_after <= now()
          AND (
            status = 'queued'
            OR (status = 'running' AND locked_until IS NOT NULL AND locked_until < now())
          )
        ORDER BY run_after ASC, created_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE commerce_jobs AS j
      SET status = 'running',
          locked_by = ${workerId},
          locked_until = now() + make_interval(secs => ${leaseSeconds}),
          attempts = j.attempts + 1,
          updated_at = now()
      FROM claimable
      WHERE j.id = claimable.id
      RETURNING j.*
    `.execute(db);
    return result.rows.map(toJob);
  }

  /** Mark a leased job succeeded. `last_error` is left alone — "worked on the fourth try" is a fact. */
  async markDone(id: string): Promise<void> {
    await db
      .updateTable('commerce_jobs')
      .set({
        status: 'done',
        locked_by: null,
        locked_until: null,
        finished_at: new Date(),
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .execute();
  }

  /** Put a job back on the queue with a later `run_after`. Used when the fault looked transient. */
  async markForRetry(id: string, error: string, runAfter: Date): Promise<void> {
    await db
      .updateTable('commerce_jobs')
      .set({
        status: 'queued',
        last_error: error,
        run_after: runAfter,
        locked_by: null,
        locked_until: null,
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .execute();
  }

  /**
   * Stop trying, and record which kind of stopping this was.
   *
   * `failed` means a handler said retrying cannot help; `dead` means the attempts ran out. Both are
   * terminal, and neither deletes the row: a job that never completed is the only evidence that
   * something a client was told would happen did not.
   */
  async markTerminal(id: string, status: 'failed' | 'dead', error: string): Promise<void> {
    await db
      .updateTable('commerce_jobs')
      .set({
        status,
        last_error: error,
        locked_by: null,
        locked_until: null,
        finished_at: new Date(),
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .execute();
  }

  async findById(orgId: string, id: string): Promise<CommerceJob | null> {
    const row = await db
      .selectFrom('commerce_jobs')
      .selectAll()
      .where('org_id', '=', orgId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? null : toJob(row);
  }

  /** One tenant's jobs, newest first, optionally narrowed to a status. The operator's view. */
  async listForOrg(
    orgId: string,
    limit: number,
    status?: CommerceJobStatus,
  ): Promise<CommerceJob[]> {
    let query = db
      .selectFrom('commerce_jobs')
      .selectAll()
      .where('org_id', '=', orgId)
      .orderBy('created_at', 'desc')
      .limit(limit);
    if (status !== undefined) {
      query = query.where('status', '=', status);
    }
    const rows = await query.execute();
    return rows.map(toJob);
  }

  /**
   * How many jobs sit in each state for one tenant.
   *
   * Every state is present in the result even at zero. A caller asking "how many are dead?" must be
   * able to read the answer directly; making it distinguish "zero" from "the key wasn't there" is
   * how a monitoring check ends up reporting healthy because the lookup returned undefined.
   */
  async countsByStatus(orgId: string): Promise<Record<CommerceJobStatus, number>> {
    const rows = await db
      .selectFrom('commerce_jobs')
      .select(['status', db.fn.countAll<string>().as('count')])
      .where('org_id', '=', orgId)
      .groupBy('status')
      .execute();
    const counts: Record<CommerceJobStatus, number> = {
      queued: 0,
      running: 0,
      done: 0,
      failed: 0,
      dead: 0,
    };
    for (const row of rows) {
      counts[row.status] = Number(row.count);
    }
    return counts;
  }
}

export const jobRepository = new JobRepository();
