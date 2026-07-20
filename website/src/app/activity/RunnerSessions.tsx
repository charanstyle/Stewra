import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  GetRunnerStatusResponse,
  RunnerDevice,
  RunnerHarnessId,
  RunnerPermissionPromptPayload,
  RunnerSession,
  RunnerSessionUpdatePayload,
} from '@stewra/shared-types';
import { RUNNER_UI_EVENTS } from '@stewra/shared-types';
import { ApiError } from '../../services/api';
import { runnerService } from '../../services/runnerService';
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

/**
 * The runner Sessions surface: start a coding agent on one of your machines, watch its output stream live,
 * and answer the permission prompts it raises — all against a throwaway git worktree on your own box.
 *
 * The live stream and permission prompts arrive over the shared app socket (the server relays each runner's
 * reports as `runner-ui:*` events); starting/prompting/cancelling/answering go back over REST.
 */
export default function RunnerSessions(): React.JSX.Element | null {
  const socket = useSocket();
  const [status, setStatus] = useState<GetRunnerStatusResponse | null>(null);
  const [sessions, setSessions] = useState<readonly RunnerSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Composer state.
  const [deviceId, setDeviceId] = useState<string>('');
  const [harness, setHarness] = useState<RunnerHarnessId | ''>('');
  const [workspaceId, setWorkspaceId] = useState<string>('');
  const [prompt, setPrompt] = useState<string>('');
  const [followUp, setFollowUp] = useState<string>('');

  // Live view state.
  const [activeId, setActiveId] = useState<string | null>(null);
  const logsRef = useRef<Map<string, LogItem[]>>(new Map());
  const [, forceRender] = useState(0);
  const [permission, setPermission] = useState<RunnerPermissionPromptPayload | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [statusRes, sessionsRes] = await Promise.all([
        runnerService.getStatus(),
        runnerService.listSessions().catch(() => ({ sessions: [] })),
      ]);
      setStatus(statusRes);
      setSessions(sessionsRes.sessions);
    } catch {
      // Background poll — stay quiet; user actions surface their own errors.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

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

  const onlineDevices = useMemo(
    () => (status?.devices ?? []).filter((d) => d.online),
    [status],
  );
  const selectedDevice: RunnerDevice | undefined = useMemo(
    () => onlineDevices.find((d) => d.id === deviceId),
    [onlineDevices, deviceId],
  );

  const startSession = useCallback(async (): Promise<void> => {
    if (!selectedDevice || harness === '' || workspaceId === '' || prompt.trim() === '') return;
    setError(null);
    setBusy(true);
    try {
      const { session } = await runnerService.startSession({
        deviceId: selectedDevice.id,
        harness,
        workspaceId,
        prompt: prompt.trim(),
      });
      logsRef.current.set(session.id, []);
      setActiveId(session.id);
      setPrompt('');
      await refresh();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }, [selectedDevice, harness, workspaceId, prompt, refresh]);

  const answer = useCallback(
    async (optionId: string): Promise<void> => {
      if (permission === null) return;
      const current = permission;
      setPermission(null);
      try {
        await runnerService.decidePermission(current.sessionId, { promptId: current.promptId, optionId });
      } catch (err) {
        setError(describeError(err));
        setPermission(current); // let the user try again
      }
    },
    [permission],
  );

  const sendFollowUp = useCallback(async (): Promise<void> => {
    if (activeId === null || followUp.trim() === '') return;
    try {
      await runnerService.promptSession(activeId, { text: followUp.trim() });
      setFollowUp('');
    } catch (err) {
      setError(describeError(err));
    }
  }, [activeId, followUp]);

  const cancel = useCallback(
    async (id: string): Promise<void> => {
      try {
        await runnerService.cancelSession(id);
        await refresh();
      } catch (err) {
        setError(describeError(err));
      }
    },
    [refresh],
  );

  if (status === null || !status.enabled) return null;

  const activeSession = sessions.find((s) => s.id === activeId) ?? null;
  const activeLog = activeId !== null ? (logsRef.current.get(activeId) ?? []) : [];

  return (
    <div className={styles.card}>
      <h2 className={styles.cardTitle}>
        Runner sessions
        <span className={styles.badge}>Experimental</span>
      </h2>

      {error && <div className={styles.error}>{error}</div>}

      {onlineDevices.length === 0 ? (
        <p className={styles.muted}>
          No runner is online. Start a runner on one of your machines (<code>stewra-runner run</code>) to
          begin a session.
        </p>
      ) : (
        <div className={styles.composer}>
          <div className={styles.row}>
            <label className={styles.field}>
              <span className={styles.label}>Machine</span>
              <select
                className={styles.select}
                value={deviceId}
                onChange={(e) => {
                  setDeviceId(e.target.value);
                  setHarness('');
                  setWorkspaceId('');
                }}
              >
                <option value="">Choose a machine…</option>
                {onlineDevices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.os})
                  </option>
                ))}
              </select>
            </label>

            <label className={styles.field}>
              <span className={styles.label}>Agent</span>
              <select
                className={styles.select}
                value={harness}
                disabled={!selectedDevice}
                onChange={(e) => {
                  const found = (selectedDevice?.harnesses ?? []).find((h) => h.id === e.target.value);
                  setHarness(found ? found.id : '');
                }}
              >
                <option value="">Choose an agent…</option>
                {(selectedDevice?.harnesses ?? [])
                  .filter((h) => h.available)
                  .map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.id}
                    </option>
                  ))}
              </select>
            </label>

            <label className={styles.field}>
              <span className={styles.label}>Workspace</span>
              <select
                className={styles.select}
                value={workspaceId}
                disabled={!selectedDevice}
                onChange={(e) => setWorkspaceId(e.target.value)}
              >
                <option value="">Choose a repo…</option>
                {(selectedDevice?.workspaces ?? []).map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <textarea
            className={styles.prompt}
            placeholder="What should the agent do? e.g. 'Add a health-check endpoint and a test for it.'"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
          />
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.primary}
              disabled={busy || !selectedDevice || harness === '' || workspaceId === '' || prompt.trim() === ''}
              onClick={() => void startSession()}
            >
              {busy ? 'Starting…' : 'Start session'}
            </button>
          </div>
        </div>
      )}

      {sessions.length > 0 && (
        <ul className={styles.sessionList}>
          {sessions.map((s) => (
            <li
              key={s.id}
              className={`${styles.sessionRow} ${s.id === activeId ? styles.sessionActive : ''}`}
            >
              <button type="button" className={styles.sessionOpen} onClick={() => setActiveId(s.id)}>
                <span className={`${styles.status} ${styles[`status_${s.status}`] ?? ''}`}>{s.status}</span>
                <span className={styles.sessionPrompt}>{s.prompt}</span>
                <span className={styles.sessionMeta}>
                  {s.harness} · {s.workspaceName} · {s.deviceName}
                </span>
              </button>
              {isActive(s) && (
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
            <strong>{activeSession.workspaceName}</strong>
            <span className={styles.sessionMeta}>{activeSession.harness} · {activeSession.deviceName}</span>
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

          {permission !== null && permission.sessionId === activeSession.id && (
            <div className={styles.permission}>
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

          {isActive(activeSession) && (
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
        </div>
      )}
    </div>
  );
}
