import { db } from '../database/index.js';

export type RunnerChatChannel = 'stewra_chat' | 'whatsapp';

/** Where a session's relayed lines go, captured when it is started from a conversation. */
export interface RunnerOrigin {
  readonly userId: string;
  readonly conversationId: string;
  readonly channel: RunnerChatChannel;
  readonly deviceName: string;
  readonly workspaceName: string;
  /** The project's name at start, when the checkout was bound to one — what the relayed lines say. */
  readonly projectName: string | null;
}

/**
 * The permission gate a chat-watched session is currently blocked on — enough to resolve a
 * natural-language "yes"/"no" reply into a concrete decision without the user ever seeing an id.
 */
export interface PendingRunnerPermission {
  readonly userId: string;
  readonly sessionId: string;
  readonly promptId: string;
  readonly allowOptionId: string | null;
  readonly denyOptionId: string | null;
  readonly title: string;
}

/**
 * The rows behind the chat relay (migration 066). Keyed by session; the session's own `user_id` is
 * the member who started it, which is who the relay speaks to. Nothing here is org-scoped because
 * nothing here is reached from an org route — a session id arrives from the runner socket, already
 * authenticated as a device.
 */
class RunnerChatRelayRepository {
  async saveOrigin(sessionId: string, origin: RunnerOrigin): Promise<void> {
    await db
      .insertInto('runner_chat_origins')
      .values({
        session_id: sessionId,
        user_id: origin.userId,
        conversation_id: origin.conversationId,
        channel: origin.channel,
        device_name: origin.deviceName,
        workspace_name: origin.workspaceName,
        project_name: origin.projectName,
      })
      .onConflict((oc) =>
        oc.column('session_id').doUpdateSet({
          user_id: origin.userId,
          conversation_id: origin.conversationId,
          channel: origin.channel,
          device_name: origin.deviceName,
          workspace_name: origin.workspaceName,
          project_name: origin.projectName,
        }),
      )
      .execute();
  }

  async findOrigin(sessionId: string): Promise<RunnerOrigin | null> {
    const row = await db
      .selectFrom('runner_chat_origins')
      .selectAll()
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    if (row === undefined) return null;
    return {
      userId: row.user_id,
      conversationId: row.conversation_id,
      channel: row.channel,
      deviceName: row.device_name,
      workspaceName: row.workspace_name,
      projectName: row.project_name,
    };
  }

  async deleteOrigin(sessionId: string): Promise<void> {
    await db.deleteFrom('runner_chat_origins').where('session_id', '=', sessionId).execute();
  }

  async savePending(pending: PendingRunnerPermission): Promise<void> {
    await db
      .insertInto('runner_chat_pending_permissions')
      .values({
        session_id: pending.sessionId,
        user_id: pending.userId,
        prompt_id: pending.promptId,
        allow_option_id: pending.allowOptionId,
        deny_option_id: pending.denyOptionId,
        title: pending.title,
      })
      .onConflict((oc) =>
        oc.column('session_id').doUpdateSet({
          user_id: pending.userId,
          prompt_id: pending.promptId,
          allow_option_id: pending.allowOptionId,
          deny_option_id: pending.denyOptionId,
          title: pending.title,
        }),
      )
      .execute();
  }

  /** The newest gate any of this person's sessions is blocked on, or null. */
  async latestPendingForUser(userId: string): Promise<PendingRunnerPermission | null> {
    const row = await db
      .selectFrom('runner_chat_pending_permissions')
      .selectAll()
      .where('user_id', '=', userId)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (row === undefined) return null;
    return {
      userId: row.user_id,
      sessionId: row.session_id,
      promptId: row.prompt_id,
      allowOptionId: row.allow_option_id,
      denyOptionId: row.deny_option_id,
      title: row.title,
    };
  }

  async deletePending(sessionId: string): Promise<void> {
    await db.deleteFrom('runner_chat_pending_permissions').where('session_id', '=', sessionId).execute();
  }
}

export const runnerChatRelayRepository = new RunnerChatRelayRepository();
