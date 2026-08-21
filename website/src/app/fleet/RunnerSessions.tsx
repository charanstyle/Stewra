import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  RunnerPermissionPromptPayload,
  RunnerSession,
  RunnerSessionUpdatePayload,
} from '@stewra/shared-types';
import { RUNNER_UI_EVENTS } from '@stewra/shared-types';
import { ApiError } from '../../services/api';
import { orgRunnerService } from '../../services/projectService';
import { useSocket } from '../../hooks/useSocket';
import styles from './RunnerSessions.module.css';

const POLL_INTERVAL_MS = 5000;

function describeError(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong';
}

/** Sessions still taking instructions — a running session can be prompted/cancelled; a finished one can't. */
function isActive(session: RunnerSession): boolean {
  return session.endedAt === null;
}

interface LogItem {
  readonly seq: number;
  readonly kind: RunnerSessionUpdatePayload['kind'];
  readonly text?: string;
  readonly tool?: string;
}

interface RunnerSessionsProps {
  /** The org whose sessions are shown — the fleet page's selected org, always the path segment. */
  readonly orgId: string;
  /** A session the page just started (from the matrix or the launcher): open its live view. */
  readonly focusSessionId: string | null;
  readonly canWrite: boolean;
}

/**
 * The sessions workbench: watch a coding agent's output stream live, answer the permission prompts it
 * raises, send follow-ups, and push / open a PR from the isolated branch it worked on. Sessions are
 * STARTED elsewhere on the fleet page — by project, or from a matrix cell — and land here.
 *
 * The live stream and permission prompts arrive over the shared app socket (the server relays each
 * runner's reports as `runner-ui:*` events to the member who started the session); everything the
 * user does goes back over REST.
 */
export default function RunnerSessions({ orgId, focusSessionId, canWrite }: RunnerSessionsProps): React.JSX.Element {
  const socket = useSocket();
  const [sessions, setSessions] = useState<readonly RunnerSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [followUp, setFollowUp] = useState<string>('');

  // Git follow-through state (push / open-PR on a finished session).
  const [prTitle, setPrTitle] = useState<string>('');
  const [followBusy, setFollowBusy] = useState(false);
  const [followMsg, setFollowMsg] = useState<string | null>(null);

  // Live view state.
  const [activeId, setActiveId] = useState<string | null>(null);
  const logsRef = useRef<Map<string, LogItem[]>>(new Map());
  const [, forceRender] = useState(0);
  const [permission, setPermission] = useState<RunnerPermissionPromptPayload | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await orgRunnerService.listSessions(orgId);
      setSessions(res.sessions);
    } catch (err) {
      // A background poll that fails is still a fact the user should see — once, not every 5s.
      setError((current) => current ?? describeError(err));
    }
  }, [orgId]);

  useEffect(() => {
    setSessions([]);
    setActiveId(null);
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (focusSessionId !== null) {
      logsRef.current.set(focusSessionId, logsRef.current.get(focusSessionId) ?? []);
      setActiveId(focusSessionId);
      void refresh();
    }
  }, [focusSessionId, refresh]);

  // Subscribe to the live runner-session stream once, for the lifetime of the socket.
  useEffect(() => {
    if (!socket) return undefined;

    const onUpdate = (event: RunnerSessionUpdatePayload): void => {
      const list = logsRef.current.get(event.sessionId) ?? [];
      const item: LogItem = {
        seq: event.seq,
        kind: event.kind,
        ...(event.text !== undefined ? { text: event.text } : {}),
        ...(event.tool !== undefined ? { tool: event.tool } : {}),
      };
      logsRef.current.set(event.sessionId, [...list, item]);
      forceRender((n) => n + 1);
    };
    const onDone = (): void => {
      setPermission(null);
      void refresh();
    };
    const onPermission = (event: RunnerPermissionPromptPayload): void => {
      setPermission(event);
      setActiveId(event.sessionId);
    };

    socket.on(RUNNER_UI_EVENTS.SESSION_UPDATE, onUpdate);
    socket.on(RUNNER_UI_EVENTS.SESSION_DONE, onDone);
    socket.on(RUNNER_UI_EVENTS.PERMISSION_REQUEST, onPermission);
    return () => {
      socket.off(RUNNER_UI_EVENTS.SESSION_UPDATE, onUpdate);
      socket.off(RUNNER_UI_EVENTS.SESSION_DONE, onDone);
      socket.off(RUNNER_UI_EVENTS.PERMISSION_REQUEST, onPermission);
    };
  }, [socket, refresh]);

  const answer = useCallback(
    async (optionId: string): Promise<void> => {
      if (permission === null) return;
      const current = permission;
      setPermission(null);
      try {
        await orgRunnerService.decidePermission(orgId, current.sessionId, { promptId: current.promptId, optionId });
      } catch (err) {
        setError(describeError(err));
        setPermission(current); // let the user try again
      }
    },
    [orgId, permission],
  );

  const sendFollowUp = useCallback(async (): Promise<void> => {
    if (activeId === null || followUp.trim() === '') return;
    try {
      await orgRunnerService.promptSession(orgId, activeId, { text: followUp.trim() });
      setFollowUp('');
    } catch (err) {
      setError(describeError(err));
    }
  }, [orgId, activeId, followUp]);

  const cancel = useCallback(
    async (id: string): Promise<void> => {
      try {
        await orgRunnerService.cancelSession(orgId, id);
        await refresh();
      } catch (err) {
        setError(describeError(err));
      }
    },
    [orgId, refresh],
  );

  // Replace one session in local state with the server's refreshed copy (after a push / PR).
  const mergeSession = useCallback((updated: RunnerSession): void => {
    setSessions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
  }, []);

  const push = useCallback(
    async (id: string): Promise<void> => {
      setFollowBusy(true);
      setFollowMsg(null);
      try {
        const res = await orgRunnerService.pushSession(orgId, id);
        mergeSession(res.session);
        setFollowMsg(res.remoteUrl !== null ? `Pushed to ${res.remoteUrl}` : 'Branch pushed');
      } catch (err) {
        setFollowMsg(describeError(err));
      } finally {
        setFollowBusy(false);
      }
    },
    [orgId, mergeSession],
  );

  const openPr = useCallback(
    async (session: RunnerSession): Promise<void> => {
      if (prTitle.trim() === '') return;
      setFollowBusy(true);
      setFollowMsg(null);
      try {
        const body = `Opened from a Stewra runner session on ${session.deviceName}.\n\n> ${session.prompt}`;
        const res = await orgRunnerService.openPr(orgId, session.id, { title: prTitle.trim(), body });
        mergeSession(res.session);
        setFollowMsg(`Opened ${res.prUrl}`);
      } catch (err) {
        setFollowMsg(describeError(err));
      } finally {
        setFollowBusy(false);
      }
    },
    [orgId, prTitle, mergeSession],
  );

  // Prefill the PR title from the session's opening prompt when switching sessions; clear stale follow-up UI.
  useEffect(() => {
    const s = sessions.find((x) => x.id === activeId);
    setPrTitle(s ? (s.prompt.split('\n')[0] ?? '').slice(0, 72) : '');
    setFollowMsg(null);
    // Intentionally keyed on activeId only: re-running on every `sessions` poll would clobber a title edit.
  }, [activeId]);

  const activeSession = sessions.find((s) => s.id === activeId) ?? null;
  const activeLog = activeId !== null ? (logsRef.current.get(activeId) ?? []) : [];

  return (
    <div className={styles.card} data-testid="fleet-sessions">
      <h2 className={styles.cardTitle}>Sessions</h2>

      {error && <div className={styles.error}>{error}</div>}

      {sessions.length === 0 ? (
        <p className={styles.muted}>No sessions yet. Start one from a project above.</p>
      ) : (
        <ul className={styles.sessionList}>
          {sessions.map((s) => (
            <li
              key={s.id}
              className={`${styles.sessionRow} ${s.id === activeId ? styles.sessionActive : ''}`}
              data-testid="fleet-session-row"
            >
              <button type="button" className={styles.sessionOpen} onClick={() => setActiveId(s.id)}>
                <span className={`${styles.status} ${styles[`status_${s.status}`] ?? ''}`}>{s.status}</span>
                <span className={styles.sessionPrompt}>{s.prompt}</span>
                <span className={styles.sessionMeta}>
                  {s.projectName ?? s.workspaceName} · {s.harness} · {s.deviceName}
                </span>
              </button>
              {canWrite && isActive(s) && (
                <button type="button" className={styles.ghost} onClick={() => void cancel(s.id)}>
                  Cancel
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {activeSession !== null && (
        <div className={styles.viewer}>
          <div className={styles.viewerHead}>
            <strong>{activeSession.projectName ?? activeSession.workspaceName}</strong>
            <span className={styles.sessionMeta}>
              {activeSession.workspaceName} · {activeSession.harness} · {activeSession.deviceName}
            </span>
          </div>

          <div className={styles.log}>
            {activeLog.length === 0 && <p className={styles.muted}>Waiting for the agent…</p>}
            {activeLog.map((item) => (
              <div key={item.seq} className={`${styles.logItem} ${styles[`log_${item.kind}`] ?? ''}`}>
                {item.kind !== 'agent-message' && <span className={styles.logKind}>{item.tool ?? item.kind}</span>}
                {item.text !== undefined && <pre className={styles.logText}>{item.text}</pre>}
              </div>
            ))}
          </div>

          {canWrite && permission !== null && permission.sessionId === activeSession.id && (
            <div className={styles.permission} data-testid="fleet-permission">
              <div className={styles.permTitle}>Permission needed: {permission.title}</div>
              {permission.detail !== permission.title && (
                <pre className={styles.permDetail}>{permission.detail}</pre>
              )}
              <div className={styles.permOptions}>
                {permission.options.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    className={o.kind.startsWith('allow') ? styles.permAllow : styles.permDeny}
                    onClick={() => void answer(o.id)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {canWrite && isActive(activeSession) && (
            <div className={styles.followUp}>
              <input
                className={styles.followInput}
                placeholder="Send a follow-up instruction…"
                value={followUp}
                onChange={(e) => setFollowUp(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void sendFollowUp();
                }}
              />
              <button type="button" className={styles.secondary} onClick={() => void sendFollowUp()}>
                Send
              </button>
            </div>
          )}

          {/* Git follow-through: a finished session's work lives on an isolated branch the user can push / PR. */}
          {!isActive(activeSession) && activeSession.branch !== null && (
            <div className={styles.followThrough}>
              <div className={styles.branchRow}>
                <span className={styles.logKind}>branch</span>
                <code className={styles.branchName}>{activeSession.branch}</code>
                {activeSession.pushed && <span className={styles.pushedBadge}>pushed</span>}
              </div>

              {activeSession.prUrl !== null ? (
                <a
                  className={styles.prLink}
                  href={activeSession.prUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  View pull request →
                </a>
              ) : (
                canWrite && (
                  <div className={styles.followActions}>
                    <input
                      className={styles.followInput}
                      placeholder="Pull request title"
                      value={prTitle}
                      onChange={(e) => setPrTitle(e.target.value)}
                    />
                    <button
                      type="button"
                      className={styles.secondary}
                      disabled={followBusy}
                      onClick={() => void push(activeSession.id)}
                    >
                      {activeSession.pushed ? 'Re-push' : 'Push'}
                    </button>
                    <button
                      type="button"
                      className={styles.primary}
                      disabled={followBusy || prTitle.trim() === ''}
                      onClick={() => void openPr(activeSession)}
                    >
                      Open PR
                    </button>
                  </div>
                )
              )}

              {followMsg !== null && <div className={styles.followMsg}>{followMsg}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
