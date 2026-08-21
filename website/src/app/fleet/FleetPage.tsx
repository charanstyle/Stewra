import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { roleMeetsMinimum, RUNNER_ENVIRONMENTS } from '@stewra/shared-types';
import type {
  CreateProjectRequest,
  MachineAccessRequest,
  Project,
  ProjectWorkspaceBinding,
  RunnerDevice,
  RunnerEnvironment,
  RunnerHarnessId,
  StartRunnerPairingResponse,
  UpdateProjectRequest,
} from '@stewra/shared-types';
import { AppNav } from '../../components/AppNav/AppNav';
import { api, ApiError } from '../../services/api';
import { machineAccessService, orgRunnerService, projectService } from '../../services/projectService';
import { useCommerceOrg } from '../commerce/useCommerceOrg';
import FleetMatrix, { cellOf } from './FleetMatrix';
import type { Cell } from './FleetMatrix';
import ProjectForm from './ProjectForm';
import BindDialog from './BindDialog';
import SessionLauncher from './SessionLauncher';
import type { LaunchTarget } from './SessionLauncher';
import RunnerSessions from './RunnerSessions';
import styles from './FleetPage.module.css';

const POLL_INTERVAL_MS = 5000;

function describeError(err: unknown): string {
  return err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Something went wrong';
}

type Dialog =
  | { readonly kind: 'none' }
  | { readonly kind: 'project'; readonly project: Project | null }
  | { readonly kind: 'bind'; readonly cell: Cell }
  | {
      readonly kind: 'launch';
      readonly target: LaunchTarget;
      readonly choices: ReadonlyArray<{ readonly id: string; readonly name: string }> | null;
    };

/**
 * `/fleet` — an organization's projects, the machines that run them, and the sessions on them.
 *
 * Everything here is org-scoped: the org comes from the selector and rides as the path segment on
 * every call. `viewer` sees the matrix; `admin` (and owner) can change it. Nothing on this page is
 * decided by guessing — a project on two machines asks which one, a production machine asks for its
 * name, a checkout the machine has stopped reporting says so in words.
 */
export default function FleetPage(): React.JSX.Element {
  const { memberships, orgId, setOrgId, role, loadError } = useCommerceOrg();
  const canWrite = role !== null && roleMeetsMinimum(role, 'admin');

  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [devices, setDevices] = useState<readonly RunnerDevice[]>([]);
  const [projects, setProjects] = useState<readonly Project[]>([]);
  const [bindings, setBindings] = useState<readonly ProjectWorkspaceBinding[]>([]);
  const [accessRequests, setAccessRequests] = useState<readonly MachineAccessRequest[]>([]);
  const [pairing, setPairing] = useState<StartRunnerPairingResponse | null>(null);
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [focusSessionId, setFocusSessionId] = useState<string | null>(null);
  const [moveTarget, setMoveTarget] = useState<Record<string, string>>({});

  const refresh = useCallback(async (): Promise<void> => {
    if (orgId === null) return;
    try {
      const [status, projectList, bindingList, access] = await Promise.all([
        orgRunnerService.getStatus(orgId),
        projectService.list(orgId),
        projectService.listBindings(orgId),
        machineAccessService.list(orgId),
      ]);
      setEnabled(status.enabled);
      setDevices(status.devices);
      setProjects(projectList.projects);
      setBindings(bindingList.bindings);
      setAccessRequests(access.requests);
    } catch (err) {
      setError(describeError(err));
    }
  }, [orgId]);

  useEffect(() => {
    setDevices([]);
    setProjects([]);
    setBindings([]);
    setAccessRequests([]);
    setPairing(null);
    setDialog({ kind: 'none' });
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const orgName = memberships.find((m) => m.org.id === orgId)?.org.name ?? '';

  /** Run an admin action: clear the banners, show its failure, reload the page's facts. */
  const act = useCallback(
    async (fn: () => Promise<string | null>): Promise<boolean> => {
      setError(null);
      setNotice(null);
      setBusy(true);
      try {
        const msg = await fn();
        if (msg !== null) setNotice(msg);
        await refresh();
        return true;
      } catch (err) {
        setError(describeError(err));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  // ── Machines ─────────────────────────────────────────────────────────────────────────────────
  const mintCode = (): void => {
    if (orgId === null) return;
    void act(async () => {
      setPairing(await orgRunnerService.startPairing(orgId));
      return null;
    });
  };

  const setEnvironment = (device: RunnerDevice, environment: RunnerEnvironment): void => {
    if (orgId === null) return;
    void act(async () => {
      await orgRunnerService.updateDevice(orgId, device.id, { environment });
      return `${device.name} is now a ${environment} machine.`;
    });
  };

  const rescan = (device: RunnerDevice): void => {
    if (orgId === null) return;
    void act(async () => {
      const { ok } = await orgRunnerService.rescanDevice(orgId, device.id);
      return ok ? `Asked ${device.name} to rescan its workspaces.` : `${device.name} is not connected right now.`;
    });
  };

  const revoke = (device: RunnerDevice): void => {
    if (orgId === null) return;
    if (!window.confirm(`Revoke ${device.name}? Its token stops working immediately and any running session is cancelled.`)) return;
    void act(async () => {
      await orgRunnerService.revokeDevice(orgId, device.id);
      return `${device.name} revoked.`;
    });
  };

  const move = (device: RunnerDevice): void => {
    const toOrgId = moveTarget[device.id];
    if (orgId === null || toOrgId === undefined || toOrgId === '') return;
    const toName = memberships.find((m) => m.org.id === toOrgId)?.org.name ?? 'that organization';
    void act(async () => {
      await orgRunnerService.moveDevice(orgId, device.id, { toOrgId });
      return `${device.name} moved to ${toName}. Its past sessions stay here.`;
    });
  };

  // ── Machine access ───────────────────────────────────────────────────────────────────────────
  /**
   * Answer someone outside this organization who is asking to see one of its machines.
   *
   * Approving grants sight of THAT ONE MACHINE — not membership, not the org's other machines, not the
   * ability to start a session on it. A refusal is a decision and is recorded as one: nothing re-asks it.
   */
  const decideAccess = (req: MachineAccessRequest, approve: boolean): void => {
    if (orgId === null) return;
    void act(async () => {
      await machineAccessService.decide(orgId, req.id, { approve });
      return approve
        ? `${req.requestedByName} can now see ${req.deviceName}.`
        : `Turned down ${req.requestedByName}'s request to see ${req.deviceName}.`;
    });
  };

  const pendingAccess = accessRequests.filter((r) => r.status === 'pending');

  // ── Projects ─────────────────────────────────────────────────────────────────────────────────
  const createProject = async (body: CreateProjectRequest): Promise<void> => {
    if (orgId === null) return;
    const ok = await act(async () => {
      await projectService.create(orgId, body);
      return `${body.name} created.`;
    });
    if (ok) setDialog({ kind: 'none' });
  };

  const updateProject = async (projectId: string, body: UpdateProjectRequest): Promise<void> => {
    if (orgId === null) return;
    const ok = await act(async () => {
      await projectService.update(orgId, projectId, body);
      return 'Saved.';
    });
    if (ok) setDialog({ kind: 'none' });
  };

  const archiveProject = (project: Project): void => {
    if (orgId === null) return;
    if (!window.confirm(`Archive ${project.name}? It stops accepting sessions; its history stays.`)) return;
    void act(async () => {
      await projectService.archive(orgId, project.id);
      return `${project.name} archived.`;
    });
  };

  // ── Bindings ─────────────────────────────────────────────────────────────────────────────────
  const bind = async (cell: Cell, workspaceId: string): Promise<void> => {
    if (orgId === null) return;
    const ok = await act(async () => {
      await projectService.bind(orgId, cell.project.id, { deviceId: cell.device.id, workspaceId });
      return `${cell.project.name} bound on ${cell.device.name}.`;
    });
    if (ok) setDialog({ kind: 'none' });
  };

  const unbind = (cell: Cell): void => {
    if (orgId === null || cell.binding === null) return;
    const { binding } = cell;
    void act(async () => {
      await projectService.unbind(orgId, cell.project.id, binding.id);
      return `${cell.project.name} unbound from ${cell.device.name}.`;
    });
  };

  // ── Sessions ─────────────────────────────────────────────────────────────────────────────────
  const launch = async (
    target: LaunchTarget,
    args: { readonly deviceId: string | null; readonly harness: RunnerHarnessId; readonly prompt: string },
  ): Promise<void> => {
    if (orgId === null) return;
    setError(null);
    setBusy(true);
    try {
      const { session } = await orgRunnerService.startSession(orgId, {
        projectId: target.project.id,
        harness: args.harness,
        prompt: args.prompt,
        ...(args.deviceId !== null ? { deviceId: args.deviceId } : {}),
      });
      setDialog({ kind: 'none' });
      setFocusSessionId(session.id);
      setNotice(`Started on ${session.deviceName}.`);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CHOICE_REQUIRED') {
        // The server will not pick a machine. Its candidates become the question.
        setDialog({
          kind: 'launch',
          target,
          choices: err.details.map((d) => ({ id: d.field, name: d.message })),
        });
      } else {
        setError(describeError(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const readyDevicesFor = useMemo(
    () =>
      (project: Project): RunnerDevice[] =>
        devices.filter(
          (d) => cellOf(project, d, bindings.find((b) => b.projectId === project.id && b.deviceId === d.id) ?? null).state === 'ready',
        ),
    [devices, bindings],
  );

  const takenOn = (deviceId: string): ReadonlySet<string> =>
    new Set(bindings.filter((b) => b.deviceId === deviceId).map((b) => b.workspaceId));

  const otherOrgs = memberships.filter((m) => m.org.id !== orgId && roleMeetsMinimum(m.role, 'admin'));

  return (
    <div className={styles.page}>
      <AppNav />
      <main className={styles.main}>
        <h1 className={styles.title}>Fleet</h1>
        <p className={styles.subtitle}>
          The projects this organization works on, the machines that run them, and the coding-agent
          sessions on them. Pair a machine with the <Link to="/runner">Stewra Runner</Link>; kill every
          runner at once from <Link to="/activity">Activity</Link>.
        </p>

        {loadError !== null && <div className={styles.error}>{loadError}</div>}
        {error !== null && <div className={styles.error}>{error}</div>}
        {notice !== null && <div className={styles.notice}>{notice}</div>}

        <section className={styles.card}>
          <h2 className={styles.cardTitle}>Organization</h2>
          {memberships.length === 0 ? (
            <p className={styles.muted}>You do not belong to an organization yet.</p>
          ) : (
            <div className={styles.row}>
              <select className={styles.select} value={orgId ?? ''} onChange={(e) => setOrgId(e.target.value)} data-testid="fleet-org-select">
                {memberships.map((m) => (
                  <option key={m.org.id} value={m.org.id}>
                    {m.org.name} · {m.org.kind === 'individual' ? 'personal' : 'business'} · {m.role}
                  </option>
                ))}
              </select>
              {!canWrite && <span className={styles.muted}>You can look, not change — ask an admin.</span>}
            </div>
          )}
        </section>

        {orgId !== null && enabled === false && (
          <section className={styles.card}>
            <p className={styles.muted}>The runner is switched off on this server.</p>
          </section>
        )}

        {orgId !== null && enabled === true && (
          <>
            {pendingAccess.length > 0 && (
              <section className={styles.card} data-testid="fleet-access-requests">
                <h2 className={styles.cardTitle}>Waiting on you</h2>
                <p className={styles.muted}>
                  These people are running Stewra Bridge on the very computer one of {orgName}&rsquo;s
                  machines is paired from. Saying yes lets them ask Stewra about <em>that machine only</em> —
                  it is not membership, it does not reveal the rest of the fleet, and it does not let them
                  start anything on it.
                </p>
                <ul className={styles.deviceList}>
                  {pendingAccess.map((r) => (
                    <li key={r.id} className={styles.deviceRow} data-testid="fleet-access-request">
                      <span className={styles.deviceName}>{r.deviceName}</span>
                      <span className={styles.deviceMeta}>
                        {r.requestedByName} · from {r.hostname} · asked {new Date(r.requestedAt).toLocaleString()}
                      </span>
                      {canWrite ? (
                        <span className={styles.deviceActions}>
                          <button
                            type="button"
                            className={styles.secondary}
                            disabled={busy}
                            onClick={() => decideAccess(r, true)}
                            data-testid="fleet-access-approve"
                          >
                            Let them see it
                          </button>
                          <button
                            type="button"
                            className={styles.ghost}
                            disabled={busy}
                            onClick={() => decideAccess(r, false)}
                            data-testid="fleet-access-deny"
                          >
                            No
                          </button>
                        </span>
                      ) : (
                        <span className={styles.muted}>An admin decides this one.</span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className={styles.card}>
              <h2 className={styles.cardTitle}>
                Machines
                {canWrite && (
                  <button type="button" className={styles.secondary} disabled={busy} onClick={mintCode} data-testid="fleet-pair">
                    Pair a machine
                  </button>
                )}
              </h2>
              {pairing !== null && (
                <div className={styles.dialog} data-testid="fleet-pair-code">
                  <p className={styles.muted}>
                    On the machine, run this within {Math.max(1, Math.round((new Date(pairing.expiresAt).getTime() - Date.now()) / 60_000))}{' '}
                    minutes. It joins <strong>{pairing.orgName}</strong>.
                  </p>
                  <code className={styles.code}>stewra-runner pair {pairing.code}</code>
                  <p className={styles.muted}>
                    No runner yet? <a href={pairing.downloadUrl}>Download it</a>. Set <code>STEWRA_RUNNER_WORKSPACE_ROOTS</code> to
                    the folder your checkouts live under.
                  </p>
                </div>
              )}
              {devices.length === 0 ? (
                <p className={styles.muted}>No machines in {orgName} yet.</p>
              ) : (
                <ul className={styles.deviceList}>
                  {devices.map((d) => (
                    <li key={d.id} className={styles.deviceRow} data-testid="fleet-device-row">
                      <span className={styles.deviceName}>
                        <span className={`${styles.dot} ${d.online ? styles.dotOnline : ''}`} />
                        {d.name}
                        <span className={`${styles.tag} ${d.environment === 'production' ? styles.tagProd : ''}`}>{d.environment}</span>
                      </span>
                      <span className={styles.deviceMeta}>
                        {d.os} · v{d.appVersion} · {d.workspaces.length} checkout{d.workspaces.length === 1 ? '' : 's'} ·{' '}
                        {d.online ? 'online' : d.lastSeenAt !== null ? `last seen ${new Date(d.lastSeenAt).toLocaleString()}` : 'never connected'}
                      </span>
                      {canWrite && (
                        <span className={styles.deviceActions}>
                          <select
                            className={styles.select}
                            value={d.environment}
                            onChange={(e) => {
                              const env = RUNNER_ENVIRONMENTS.find((x) => x === e.target.value);
                              if (env !== undefined) setEnvironment(d, env);
                            }}
                            data-testid="fleet-device-environment"
                          >
                            {RUNNER_ENVIRONMENTS.map((env) => (
                              <option key={env} value={env}>
                                {env}
                              </option>
                            ))}
                          </select>
                          <button type="button" className={styles.secondary} disabled={busy || !d.online} onClick={() => rescan(d)} data-testid="fleet-device-rescan">
                            Rescan
                          </button>
                          {otherOrgs.length > 0 && (
                            <>
                              <select
                                className={styles.select}
                                value={moveTarget[d.id] ?? ''}
                                onChange={(e) => setMoveTarget((m) => ({ ...m, [d.id]: e.target.value }))}
                              >
                                <option value="">Move to…</option>
                                {otherOrgs.map((m) => (
                                  <option key={m.org.id} value={m.org.id}>
                                    {m.org.name}
                                  </option>
                                ))}
                              </select>
                              <button type="button" className={styles.ghost} disabled={busy || !moveTarget[d.id]} onClick={() => move(d)}>
                                Move
                              </button>
                            </>
                          )}
                          <button type="button" className={styles.danger} disabled={busy} onClick={() => revoke(d)}>
                            Revoke
                          </button>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className={styles.card}>
              <h2 className={styles.cardTitle}>
                Projects
                {canWrite && (
                  <button type="button" className={styles.secondary} disabled={busy} onClick={() => setDialog({ kind: 'project', project: null })} data-testid="fleet-project-create">
                    New project
                  </button>
                )}
              </h2>
              {projects.length === 0 ? (
                <p className={styles.muted}>No projects in {orgName} yet. A project is what you name when you ask Stewra to run something.</p>
              ) : (
                <FleetMatrix
                  projects={projects}
                  devices={devices}
                  bindings={bindings}
                  canWrite={canWrite}
                  onRunHere={(cell) => setDialog({ kind: 'launch', target: { project: cell.project, device: cell.device }, choices: null })}
                  onRunAnywhere={(project) => setDialog({ kind: 'launch', target: { project, device: null }, choices: null })}
                  onBind={(cell) => setDialog({ kind: 'bind', cell })}
                  onUnbind={unbind}
                  onRescan={rescan}
                  onEdit={(project) => setDialog({ kind: 'project', project })}
                  onArchive={archiveProject}
                />
              )}

              {dialog.kind === 'project' && (
                <ProjectForm
                  key={dialog.project?.id ?? 'new'}
                  project={dialog.project}
                  busy={busy}
                  onCreate={createProject}
                  onUpdate={updateProject}
                  onCancel={() => setDialog({ kind: 'none' })}
                />
              )}
              {dialog.kind === 'bind' && (
                <BindDialog
                  key={`${dialog.cell.project.id}:${dialog.cell.device.id}`}
                  project={dialog.cell.project}
                  device={devices.find((d) => d.id === dialog.cell.device.id) ?? dialog.cell.device}
                  takenWorkspaceIds={takenOn(dialog.cell.device.id)}
                  busy={busy}
                  onBind={(workspaceId) => bind(dialog.cell, workspaceId)}
                  onRescan={async () => rescan(dialog.cell.device)}
                  onCancel={() => setDialog({ kind: 'none' })}
                />
              )}
              {dialog.kind === 'launch' && (
                <SessionLauncher
                  key={`${dialog.target.project.id}:${dialog.target.device?.id ?? ''}:${dialog.choices === null ? 'free' : 'choose'}`}
                  target={dialog.target}
                  readyDevices={readyDevicesFor(dialog.target.project)}
                  choices={dialog.choices}
                  busy={busy}
                  onStart={(args) => launch(dialog.target, args)}
                  onCancel={() => setDialog({ kind: 'none' })}
                />
              )}
            </section>

            <RunnerSessions orgId={orgId} focusSessionId={focusSessionId} canWrite={canWrite} />
          </>
        )}

        {orgId !== null && memberships.length > 1 && (
          <p className={styles.muted}>
            Texting Stewra acts on the organization you chose under <Link to="/commerce">Commerce</Link> (&ldquo;Use this one when I
            text Stewra&rdquo;).{' '}
            <button
              type="button"
              className={styles.ghost}
              onClick={() =>
                void act(async () => {
                  await api.setActiveOrg({ orgId });
                  return `Texting Stewra now acts on ${orgName}.`;
                })
              }
            >
              Use {orgName} when I text Stewra
            </button>
          </p>
        )}
      </main>
    </div>
  );
}
