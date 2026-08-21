import { useState } from 'react';
import type { Project, RunnerDevice } from '@stewra/shared-types';
import styles from './FleetPage.module.css';

interface BindDialogProps {
  readonly project: Project;
  readonly device: RunnerDevice;
  /** Workspace ids on this device already bound to some project — one checkout, one project. */
  readonly takenWorkspaceIds: ReadonlySet<string>;
  readonly busy: boolean;
  readonly onBind: (workspaceId: string) => Promise<void>;
  readonly onRescan: () => Promise<void>;
  readonly onCancel: () => void;
}

/**
 * Pick which of the machine's REPORTED checkouts is this project. The list is what the runner said
 * in its last hello — nothing here lets a path be typed that the machine has not reported, because a
 * binding to a checkout that is not there would only produce a session that fails at start. If the
 * checkout is missing, the fix is on the machine (mount the volume, declare the root) followed by
 * Rescan.
 */
export default function BindDialog({ project, device, takenWorkspaceIds, busy, onBind, onRescan, onCancel }: BindDialogProps): React.JSX.Element {
  // Preselect the one whose folder name is the repo name, when there is exactly one — a suggestion
  // the user confirms, never a decision made for them.
  const matches = device.workspaces.filter((w) => w.name === project.repoName && !takenWorkspaceIds.has(w.id));
  const [workspaceId, setWorkspaceId] = useState<string>(matches.length === 1 ? (matches[0]?.id ?? '') : '');
  const available = device.workspaces.filter((w) => !takenWorkspaceIds.has(w.id));

  return (
    <div className={styles.dialog} data-testid="fleet-bind-dialog">
      <h3 className={styles.dialogTitle}>
        Where is {project.name} on {device.name}?
      </h3>
      {!device.online && (
        <p className={styles.muted}>
          {device.name} is offline, so the list below is what it last reported
          {device.lastSeenAt !== null ? ` (${new Date(device.lastSeenAt).toLocaleString()})` : ''}.
        </p>
      )}
      {available.length === 0 ? (
        <p className={styles.muted}>
          {device.name} is not reporting any unbound checkout. Check the volume is mounted and the
          folder is under <code>STEWRA_RUNNER_WORKSPACE_ROOTS</code> on that machine, then Rescan.
        </p>
      ) : (
        <label className={styles.field}>
          <span className={styles.label}>Checkout</span>
          <select className={styles.select} value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} data-testid="fleet-bind-workspace">
            <option value="">Choose a checkout…</option>
            {available.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} — {w.path}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className={styles.row}>
        <button
          type="button"
          className={styles.primary}
          disabled={busy || workspaceId === ''}
          onClick={() => void onBind(workspaceId)}
          data-testid="fleet-bind-save"
        >
          {busy ? 'Binding…' : 'Bind'}
        </button>
        <button type="button" className={styles.secondary} disabled={busy || !device.online} onClick={() => void onRescan()}>
          Rescan {device.name}
        </button>
        <button type="button" className={styles.ghost} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
