import type { Project, ProjectWorkspaceBinding, RunnerDevice } from '@stewra/shared-types';
import styles from './FleetPage.module.css';

export type CellState = 'ready' | 'stale' | 'offline' | 'unbound';

export interface Cell {
  readonly project: Project;
  readonly device: RunnerDevice;
  readonly binding: ProjectWorkspaceBinding | null;
  readonly state: CellState;
}

/**
 * The four states of a project × machine cell. Never resolved by substitution: a bound checkout the
 * machine has stopped reporting is `stale` with its cause, not quietly "offline" or "ready".
 */
export function cellOf(project: Project, device: RunnerDevice, binding: ProjectWorkspaceBinding | null): Cell {
  if (binding === null) return { project, device, binding, state: 'unbound' };
  if (!device.online) return { project, device, binding, state: 'offline' };
  const reported = device.workspaces.some((w) => w.id === binding.workspaceId);
  return { project, device, binding, state: reported ? 'ready' : 'stale' };
}

interface FleetMatrixProps {
  readonly projects: readonly Project[];
  readonly devices: readonly RunnerDevice[];
  readonly bindings: readonly ProjectWorkspaceBinding[];
  readonly canWrite: boolean;
  readonly onRunHere: (cell: Cell) => void;
  readonly onRunAnywhere: (project: Project) => void;
  readonly onBind: (cell: Cell) => void;
  readonly onUnbind: (cell: Cell) => void;
  readonly onRescan: (device: RunnerDevice) => void;
  readonly onEdit: (project: Project) => void;
  readonly onArchive: (project: Project) => void;
}

/** Projects down, machines across. Each cell says whether a session can start there right now, and if not, why. */
export default function FleetMatrix({
  projects,
  devices,
  bindings,
  canWrite,
  onRunHere,
  onRunAnywhere,
  onBind,
  onUnbind,
  onRescan,
  onEdit,
  onArchive,
}: FleetMatrixProps): React.JSX.Element {
  const bindingFor = (projectId: string, deviceId: string): ProjectWorkspaceBinding | null =>
    bindings.find((b) => b.projectId === projectId && b.deviceId === deviceId) ?? null;

  return (
    <div className={styles.matrixWrap}>
      <table className={styles.matrix} data-testid="fleet-matrix">
        <thead>
          <tr>
            <th>Project</th>
            {devices.map((d) => (
              <th key={d.id}>
                <span className={styles.deviceName}>
                  <span className={`${styles.dot} ${d.online ? styles.dotOnline : ''}`} />
                  {d.name}
                </span>
                <span className={styles.projectRepo}>{d.environment}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => (
            <tr key={p.id} data-testid="fleet-project-row" data-project-name={p.name}>
              <td>
                <div className={styles.projectName}>{p.name}</div>
                {p.repoName !== p.name && <div className={styles.projectRepo}>{p.repoName}</div>}
                {p.aliases.length > 0 && (
                  <div className={styles.aliasList}>
                    {p.aliases.map((a) => (
                      <span key={a} className={styles.alias}>
                        {a}
                      </span>
                    ))}
                  </div>
                )}
                {canWrite && (
                  <div className={styles.cellActions}>
                    <button type="button" className={styles.ghost} onClick={() => onRunAnywhere(p)} data-testid="fleet-run-project">
                      Run…
                    </button>
                    <button type="button" className={styles.ghost} onClick={() => onEdit(p)}>
                      Edit
                    </button>
                    <button type="button" className={styles.ghost} onClick={() => onArchive(p)}>
                      Archive
                    </button>
                  </div>
                )}
              </td>
              {devices.map((d) => {
                const cell = cellOf(p, d, bindingFor(p.id, d.id));
                return (
                  <td key={d.id}>
                    <div className={styles.cell} data-state={cell.state} data-testid="fleet-cell">
                      <span className={styles.cellState}>{cell.state}</span>
                      {cell.binding !== null && <span className={styles.cellPath}>{cell.binding.workspacePath}</span>}
                      {cell.state === 'stale' && (
                        <span className={styles.cellCause}>
                          {d.name} is online but isn&apos;t reporting {cell.binding?.workspacePath} — check the volume is
                          mounted, then Rescan.
                        </span>
                      )}
                      {cell.state === 'offline' && (
                        <span className={styles.cellCause}>
                          {d.lastSeenAt !== null ? `Last seen ${new Date(d.lastSeenAt).toLocaleString()}` : 'Never connected'}
                        </span>
                      )}
                      {canWrite && (
                        <div className={styles.cellActions}>
                          {cell.state === 'ready' && (
                            <button type="button" className={styles.primary} onClick={() => onRunHere(cell)} data-testid="fleet-run-here">
                              Run here
                            </button>
                          )}
                          {cell.state === 'stale' && (
                            <button type="button" className={styles.secondary} onClick={() => onRescan(d)} data-testid="fleet-rescan">
                              Rescan
                            </button>
                          )}
                          {cell.state === 'unbound' && (
                            <button type="button" className={styles.secondary} onClick={() => onBind(cell)} data-testid="fleet-bind">
                              Bind…
                            </button>
                          )}
                          {cell.binding !== null && (
                            <button type="button" className={styles.ghost} onClick={() => onUnbind(cell)}>
                              Unbind
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
