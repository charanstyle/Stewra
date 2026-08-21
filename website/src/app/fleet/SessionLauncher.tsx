import { useState } from 'react';
import { RUNNER_HARNESS_IDS } from '@stewra/shared-types';
import type { Project, RunnerDevice, RunnerHarnessId } from '@stewra/shared-types';
import styles from './FleetPage.module.css';

export interface LaunchTarget {
  readonly project: Project;
  /** Named when launched from a matrix cell; absent when launched from the project row. */
  readonly device: RunnerDevice | null;
}

interface SessionLauncherProps {
  readonly target: LaunchTarget;
  /** Machines the project is `ready` on — the harness list comes from the chosen one. */
  readonly readyDevices: readonly RunnerDevice[];
  /** Set when the server answered CHOICE_REQUIRED: the user must name one of these. */
  readonly choices: ReadonlyArray<{ readonly id: string; readonly name: string }> | null;
  readonly busy: boolean;
  readonly onStart: (args: { readonly deviceId: string | null; readonly harness: RunnerHarnessId; readonly prompt: string }) => Promise<void>;
  readonly onCancel: () => void;
}

/**
 * Start a session on a project. The machine is named only when the user named it (a cell's "Run
 * here") or the server asked (409 CHOICE_REQUIRED with candidates); otherwise the server resolves
 * the single bound machine itself and refuses, with candidates, when there is more than one.
 *
 * A `production` machine requires its name typed back before the session starts. Without that the
 * label would mean nothing.
 */
export default function SessionLauncher({ target, readyDevices, choices, busy, onStart, onCancel }: SessionLauncherProps): React.JSX.Element {
  const [deviceId, setDeviceId] = useState<string>(target.device?.id ?? '');
  const [harness, setHarness] = useState<RunnerHarnessId | ''>('');
  const [prompt, setPrompt] = useState('');
  const [confirmName, setConfirmName] = useState('');

  const chosen = readyDevices.find((d) => d.id === deviceId) ?? target.device ?? null;
  // Harnesses from the chosen machine, or the union of every ready machine's when none is chosen yet.
  const harnessPool = chosen !== null ? [chosen] : readyDevices;
  const harnesses = harnessPool
    .flatMap((d) => d.harnesses.filter((h) => h.available).map((h) => h.id))
    .filter((id, i, all) => all.indexOf(id) === i);

  const needsConfirm = chosen !== null && chosen.environment === 'production';
  const confirmed = !needsConfirm || confirmName.trim() === chosen.name;
  const needsChoice = choices !== null && deviceId === '';
  const canStart = !busy && harness !== '' && prompt.trim() !== '' && confirmed && !needsChoice;

  return (
    <div className={styles.dialog} data-testid="fleet-launcher">
      <h3 className={styles.dialogTitle}>
        Run on {target.project.name}
        {chosen !== null ? ` · ${chosen.name}` : ''}
      </h3>

      {choices !== null && (
        <div className={styles.col} data-testid="fleet-launcher-choice">
          <p className={styles.muted}>{target.project.name} is on more than one machine — which one?</p>
          <ul className={styles.choiceList}>
            {choices.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className={c.id === deviceId ? styles.primary : styles.secondary}
                  onClick={() => setDeviceId(c.id)}
                >
                  {c.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className={styles.row}>
        <label className={styles.field}>
          <span className={styles.label}>Agent</span>
          <select
            className={styles.select}
            value={harness}
            onChange={(e) => setHarness(RUNNER_HARNESS_IDS.find((id) => id === e.target.value) ?? '')}
            data-testid="fleet-launcher-harness"
          >
            <option value="">Choose an agent…</option>
            {harnesses.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
      </div>
      <textarea
        className={styles.textarea}
        placeholder="What should the agent do? e.g. 'Run the test suite and fix what fails.'"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={3}
        data-testid="fleet-launcher-prompt"
      />

      {needsConfirm && chosen !== null && (
        <label className={styles.field}>
          <span className={styles.label}>
            <span className={`${styles.tag} ${styles.tagProd}`}>production</span> Type <strong>{chosen.name}</strong> to confirm a
            session on a production machine.
          </span>
          <input className={styles.input} value={confirmName} onChange={(e) => setConfirmName(e.target.value)} data-testid="fleet-launcher-confirm" />
        </label>
      )}

      <div className={styles.row}>
        <button
          type="button"
          className={styles.primary}
          disabled={!canStart}
          onClick={() => {
            if (harness === '') return;
            void onStart({ deviceId: deviceId === '' ? null : deviceId, harness, prompt: prompt.trim() });
          }}
          data-testid="fleet-launcher-start"
        >
          {busy ? 'Starting…' : 'Start session'}
        </button>
        <button type="button" className={styles.ghost} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
