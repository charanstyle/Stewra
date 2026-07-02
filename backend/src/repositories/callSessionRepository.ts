import type { CallEndReason, CallKind, CallSession, CallStatus } from '@stewra/shared-types';
import { db } from '../database/index';

interface CallSessionRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly initiated_by: string;
  readonly call_type: CallKind;
  readonly status: CallStatus;
  readonly started_at: Date | null;
  readonly ended_at: Date | null;
  readonly duration_sec: number | null;
  readonly end_reason: CallEndReason | null;
  readonly created_at: Date;
}

const CALL_SESSION_COLUMNS = [
  'id',
  'conversation_id',
  'initiated_by',
  'call_type',
  'status',
  'started_at',
  'ended_at',
  'duration_sec',
  'end_reason',
  'created_at',
] as const;

// Same columns, table-qualified for the join in listForUser (explicit list keeps them fully typed).
const QUALIFIED_CALL_SESSION_COLUMNS = [
  'call_sessions.id',
  'call_sessions.conversation_id',
  'call_sessions.initiated_by',
  'call_sessions.call_type',
  'call_sessions.status',
  'call_sessions.started_at',
  'call_sessions.ended_at',
  'call_sessions.duration_sec',
  'call_sessions.end_reason',
  'call_sessions.created_at',
] as const;

// Typed literals so insert values type-check against the column without a type assertion.
const STATUS_RINGING: CallStatus = 'ringing';
const STATUS_ACCEPTED: CallStatus = 'accepted';

function toCallSession(row: CallSessionRow): CallSession {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    initiatedBy: row.initiated_by,
    callType: row.call_type,
    status: row.status,
    startedAt: row.started_at ? row.started_at.toISOString() : null,
    endedAt: row.ended_at ? row.ended_at.toISOString() : null,
    durationSec: row.duration_sec,
    endReason: row.end_reason,
    createdAt: row.created_at.toISOString(),
  };
}

/** The set of statuses that mean a call has already reached a terminal state (close is a no-op then). */
const TERMINAL_STATUSES: ReadonlyArray<CallStatus> = ['declined', 'ended', 'failed', 'missed'];

export class CallSessionRepository {
  /**
   * Open a call session (status `ringing`) plus a `call_participants` row per known participant, in one
   * transaction. Returns the stored session — its server-generated id is the callId the signaling relay
   * and both clients key every subsequent event on.
   */
  async open(input: {
    conversationId: string;
    initiatedBy: string;
    callType: CallKind;
    participantUserIds: ReadonlyArray<string>;
  }): Promise<CallSession> {
    return db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto('call_sessions')
        .values({
          conversation_id: input.conversationId,
          initiated_by: input.initiatedBy,
          call_type: input.callType,
          status: STATUS_RINGING,
        })
        .returning(CALL_SESSION_COLUMNS)
        .executeTakeFirstOrThrow();
      const participants = Array.from(new Set(input.participantUserIds));
      if (participants.length > 0) {
        await trx
          .insertInto('call_participants')
          .values(participants.map((uid) => ({ call_id: row.id, user_id: uid })))
          .execute();
      }
      return toCallSession(row);
    });
  }

  async findById(callId: string): Promise<CallSession | undefined> {
    const row = await db
      .selectFrom('call_sessions')
      .select(CALL_SESSION_COLUMNS)
      .where('id', '=', callId)
      .executeTakeFirst();
    return row ? toCallSession(row) : undefined;
  }

  /** Mark a ringing call accepted (stamps `started_at`, which anchors the duration clock). */
  async markAccepted(callId: string): Promise<CallSession | undefined> {
    const row = await db
      .updateTable('call_sessions')
      .set({ status: STATUS_ACCEPTED, started_at: new Date() })
      .where('id', '=', callId)
      .where('status', 'in', ['ringing'])
      .returning(CALL_SESSION_COLUMNS)
      .executeTakeFirst();
    return row ? toCallSession(row) : undefined;
  }

  /**
   * Close a call to a terminal status once. Idempotent: a call already in a terminal state is left
   * untouched (concurrent end + timeout + disconnect paths converge here), so `ended_at`/duration never
   * flip-flop. Returns the stored session (post-close, or the existing terminal row).
   */
  async close(
    callId: string,
    status: CallStatus,
    endReason: CallEndReason,
    durationSec: number | null,
  ): Promise<CallSession | undefined> {
    const row = await db
      .updateTable('call_sessions')
      .set({
        status,
        end_reason: endReason,
        duration_sec: durationSec,
        ended_at: new Date(),
      })
      .where('id', '=', callId)
      .where('status', 'not in', TERMINAL_STATUSES)
      .returning(CALL_SESSION_COLUMNS)
      .executeTakeFirst();
    if (row) return toCallSession(row);
    return this.findById(callId);
  }

  /** The caller's recent calls across every conversation they actively participate in, newest-first. */
  async listForUser(userId: string, limit: number): Promise<CallSession[]> {
    const rows = await db
      .selectFrom('call_sessions')
      .innerJoin(
        'conversation_participants',
        'conversation_participants.conversation_id',
        'call_sessions.conversation_id',
      )
      .select(QUALIFIED_CALL_SESSION_COLUMNS)
      .where('conversation_participants.user_id', '=', userId)
      .where('conversation_participants.left_at', 'is', null)
      .orderBy('call_sessions.created_at', 'desc')
      .limit(limit)
      .execute();
    return rows.map(toCallSession);
  }
}

export const callSessionRepository = new CallSessionRepository();
