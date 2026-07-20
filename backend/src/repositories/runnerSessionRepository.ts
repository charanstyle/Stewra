import type { RunnerHarnessId, RunnerSession, RunnerSessionStatus } from '@stewra/shared-types';
import type { Selectable } from 'kysely';
import { db } from '../database/index.js';
import type { RunnerSessionsTable } from '../database/types.js';

function toModel(row: Selectable<RunnerSessionsTable>): RunnerSession {
  return {
    id: row.id,
    deviceId: row.device_id,
    deviceName: row.device_name,
    harness: row.harness,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    status: row.status,
    prompt: row.prompt,
    summary: row.summary,
    error: row.error,
    branch: row.branch,
    headSha: row.head_sha,
    prUrl: row.pr_url,
    pushed: row.pushed,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    endedAt: row.ended_at?.toISOString() ?? null,
  };
}

/**
 * The durable record of runner sessions — one row per agent run, its lifecycle, and how it ended.
 *
 * The row's `id` is the session id that travels on the wire to the runner (`runner:start-session`), so a
 * runner's later `session-update`/`session-done` maps straight back with no translation table. Writes are
 * always scoped by `user_id` in the WHERE clause, so a stray or forged session id from a runner can only
 * ever affect that user's own rows — never another account's.
 */
class RunnerSessionRepository {
  /** Create a session row in its opening state and return the model (its `id` is what we dispatch). */
  async create(params: {
    userId: string;
    deviceId: string;
    deviceName: string;
    harness: RunnerHarnessId;
    workspaceId: string;
    workspaceName: string;
    prompt: string;
    status: RunnerSessionStatus;
  }): Promise<RunnerSession> {
    const row = await db
      .insertInto('runner_sessions')
      .values({
        user_id: params.userId,
        device_id: params.deviceId,
        device_name: params.deviceName,
        harness: params.harness,
        workspace_id: params.workspaceId,
        workspace_name: params.workspaceName,
        prompt: params.prompt,
        status: params.status,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toModel(row);
  }

  /** One session, scoped to its owner. */
  async get(userId: string, sessionId: string): Promise<RunnerSession | null> {
    const row = await db
      .selectFrom('runner_sessions')
      .selectAll()
      .where('id', '=', sessionId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row === undefined ? null : toModel(row);
  }

  /** The user's sessions, newest first. */
  async listByUser(userId: string, limit = 50): Promise<RunnerSession[]> {
    const rows = await db
      .selectFrom('runner_sessions')
      .selectAll()
      .where('user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .execute();
    return rows.map(toModel);
  }

  /** Move a still-running session to a new non-terminal status (e.g. running ↔ awaiting-permission). */
  async setStatus(userId: string, sessionId: string, status: RunnerSessionStatus): Promise<void> {
    await db
      .updateTable('runner_sessions')
      .set({ status, updated_at: new Date() })
      .where('id', '=', sessionId)
      .where('user_id', '=', userId)
      .execute();
  }

  /** Record a terminal outcome: status + optional summary/error + the session's branch/tip + end timestamp. */
  async finish(
    userId: string,
    sessionId: string,
    params: {
      status: Extract<RunnerSessionStatus, 'completed' | 'failed' | 'cancelled'>;
      summary?: string;
      error?: string;
      branch?: string;
      headSha?: string;
    },
  ): Promise<void> {
    const now = new Date();
    await db
      .updateTable('runner_sessions')
      .set({
        status: params.status,
        summary: params.summary ?? null,
        error: params.error ?? null,
        // Only overwrite branch/head when the runner reported them (a completed run); leave prior values
        // untouched otherwise so a `null` in a failure payload can't erase a branch we already recorded.
        ...(params.branch !== undefined ? { branch: params.branch } : {}),
        ...(params.headSha !== undefined ? { head_sha: params.headSha } : {}),
        updated_at: now,
        ended_at: now,
      })
      .where('id', '=', sessionId)
      .where('user_id', '=', userId)
      .execute();
  }

  /** Mark a session's branch as pushed to its remote. */
  async markPushed(userId: string, sessionId: string): Promise<void> {
    await db
      .updateTable('runner_sessions')
      .set({ pushed: true, updated_at: new Date() })
      .where('id', '=', sessionId)
      .where('user_id', '=', userId)
      .execute();
  }

  /** Record the pull request opened for a session's branch (also implies the branch was pushed). */
  async recordPr(userId: string, sessionId: string, prUrl: string): Promise<void> {
    await db
      .updateTable('runner_sessions')
      .set({ pr_url: prUrl, pushed: true, updated_at: new Date() })
      .where('id', '=', sessionId)
      .where('user_id', '=', userId)
      .execute();
  }
}

export const runnerSessionRepository = new RunnerSessionRepository();
