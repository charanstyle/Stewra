import type { RunnerHarnessId, RunnerSession, RunnerSessionStatus } from '@stewra/shared-types';
import type { Selectable } from 'kysely';
import { db } from '../database/index.js';
import type { RunnerSessionsTable } from '../database/types.js';

function toModel(row: Selectable<RunnerSessionsTable>): RunnerSession {
  return {
    id: row.id,
    orgId: row.org_id,
    deviceId: row.device_id,
    deviceName: row.device_name,
    projectId: row.project_id,
    projectName: row.project_name === '' ? null : row.project_name,
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

type TerminalStatus = Extract<RunnerSessionStatus, 'completed' | 'failed' | 'cancelled'>;

interface FinishParams {
  status: TerminalStatus;
  summary?: string;
  error?: string;
  branch?: string;
  headSha?: string;
}

function finishValues(params: FinishParams) {
  const now = new Date();
  return {
    status: params.status,
    summary: params.summary ?? null,
    error: params.error ?? null,
    // Only overwrite branch/head when the runner reported them (a completed run); leave prior values
    // untouched otherwise so a `null` in a failure payload can't erase a branch we already recorded.
    ...(params.branch !== undefined ? { branch: params.branch } : {}),
    ...(params.headSha !== undefined ? { head_sha: params.headSha } : {}),
    updated_at: now,
    ended_at: now,
  };
}

/**
 * The durable record of runner sessions — one row per agent run, its lifecycle, and how it ended.
 *
 * The row's `id` is the session id that travels on the wire to the runner (`runner:start-session`), so a
 * runner's later `session-update`/`session-done` maps straight back with no translation table.
 *
 * TENANCY. Two kinds of caller write here, and they are scoped differently, on purpose:
 *
 * - A PERSON (a route handler, the chat relay) reads and writes by a required, non-nullable `orgId` —
 *   the org the session belongs to, copied from its device at creation and never supplied by a client.
 *   `user_id` records which member started the run; it is not a scope.
 * - The RUNNER (a socket whose token resolved to a device) writes by `deviceId`. A runner's whole
 *   authority is "this device", so a stray or forged session id can only ever touch sessions dispatched
 *   to that very machine. Scoping these by the pairer's user id was a latent bug: the moment another
 *   member starts a session, the pairer-scoped UPDATE matches nothing and the run never leaves `running`.
 */
class RunnerSessionRepository {
  /** Create a session row in its opening state and return the model (its `id` is what we dispatch). */
  async create(params: {
    orgId: string;
    userId: string;
    deviceId: string;
    deviceName: string;
    projectId: string | null;
    projectName: string | null;
    harness: RunnerHarnessId;
    workspaceId: string;
    workspaceName: string;
    prompt: string;
    status: RunnerSessionStatus;
  }): Promise<RunnerSession> {
    const row = await db
      .insertInto('runner_sessions')
      .values({
        org_id: params.orgId,
        user_id: params.userId,
        device_id: params.deviceId,
        device_name: params.deviceName,
        project_id: params.projectId,
        project_name: params.projectName ?? '',
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

  // ── Person-scoped (by org) ──────────────────────────────────────────────────────────────────────────

  /** One session, scoped to its org. */
  async get(orgId: string, sessionId: string): Promise<RunnerSession | null> {
    const row = await db
      .selectFrom('runner_sessions')
      .selectAll()
      .where('id', '=', sessionId)
      .where('org_id', '=', orgId)
      .executeTakeFirst();
    return row === undefined ? null : toModel(row);
  }

  /** The org's sessions, newest first. */
  async listByOrg(orgId: string, limit = 50): Promise<RunnerSession[]> {
    const rows = await db
      .selectFrom('runner_sessions')
      .selectAll()
      .where('org_id', '=', orgId)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .execute();
    return rows.map(toModel);
  }

  /** Move a still-running session to a new non-terminal status (e.g. running ↔ awaiting-permission). */
  async setStatus(orgId: string, sessionId: string, status: RunnerSessionStatus): Promise<void> {
    await db
      .updateTable('runner_sessions')
      .set({ status, updated_at: new Date() })
      .where('id', '=', sessionId)
      .where('org_id', '=', orgId)
      .execute();
  }

  /** Record a terminal outcome on a person's say-so (cancel, dispatch failure). */
  async finish(orgId: string, sessionId: string, params: FinishParams): Promise<void> {
    await db
      .updateTable('runner_sessions')
      .set(finishValues(params))
      .where('id', '=', sessionId)
      .where('org_id', '=', orgId)
      .execute();
  }

  /** Mark a session's branch as pushed to its remote. */
  async markPushed(orgId: string, sessionId: string): Promise<void> {
    await db
      .updateTable('runner_sessions')
      .set({ pushed: true, updated_at: new Date() })
      .where('id', '=', sessionId)
      .where('org_id', '=', orgId)
      .execute();
  }

  /** Record the pull request opened for a session's branch (also implies the branch was pushed). */
  async recordPr(orgId: string, sessionId: string, prUrl: string): Promise<void> {
    await db
      .updateTable('runner_sessions')
      .set({ pr_url: prUrl, pushed: true, updated_at: new Date() })
      .where('id', '=', sessionId)
      .where('org_id', '=', orgId)
      .execute();
  }

  // ── Runner-scoped (by device) ───────────────────────────────────────────────────────────────────────

  /**
   * Who to relay a runner's report to: the session's tenant and the MEMBER who started it. Null when no
   * session with that id was ever dispatched to this device — a forged or stale id, dropped by the caller.
   */
  async findRouting(deviceId: string, sessionId: string): Promise<{ orgId: string; userId: string } | null> {
    const row = await db
      .selectFrom('runner_sessions')
      .select(['org_id', 'user_id'])
      .where('id', '=', sessionId)
      .where('device_id', '=', deviceId)
      .executeTakeFirst();
    return row === undefined ? null : { orgId: row.org_id, userId: row.user_id };
  }

  /** One session, as the runner it was dispatched to may see it. */
  async getByDevice(deviceId: string, sessionId: string): Promise<RunnerSession | null> {
    const row = await db
      .selectFrom('runner_sessions')
      .selectAll()
      .where('id', '=', sessionId)
      .where('device_id', '=', deviceId)
      .executeTakeFirst();
    return row === undefined ? null : toModel(row);
  }

  /** Status change reported by the runner (running ↔ awaiting-permission). */
  async setStatusByDevice(deviceId: string, sessionId: string, status: RunnerSessionStatus): Promise<void> {
    await db
      .updateTable('runner_sessions')
      .set({ status, updated_at: new Date() })
      .where('id', '=', sessionId)
      .where('device_id', '=', deviceId)
      .execute();
  }

  /** Terminal outcome reported by the runner (`session-done`). */
  async finishByDevice(deviceId: string, sessionId: string, params: FinishParams): Promise<void> {
    await db
      .updateTable('runner_sessions')
      .set(finishValues(params))
      .where('id', '=', sessionId)
      .where('device_id', '=', deviceId)
      .execute();
  }
}

export const runnerSessionRepository = new RunnerSessionRepository();
