import { useCallback, useEffect, useState } from 'react';
import type {
  GetRunnerStatusResponse,
  RunnerDevice,
  StartRunnerPairingResponse,
} from '@stewra/shared-types';
import { ApiError } from '../../services/api';
import { runnerService } from '../../services/runnerService';
import { LaptopIcon } from '../../components/icons/Icons';
import styles from './RunnerPanel.module.css';

/** How often we re-fetch runner status. Like the bridge panel, `online` is a live fact composed at read
 * time on the server, so the connected dot is kept fresh by polling this endpoint. */
const POLL_INTERVAL_MS = 5000;

function describeError(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong';
}

function harnessLabel(device: RunnerDevice): string {
  const available = device.harnesses.filter((h) => h.available).map((h) => h.id);
  return available.length > 0 ? available.join(', ') : 'none reported';
}

interface RunnerPanelProps {
  readonly emailVerified: boolean;
}

export default function RunnerPanel({
  emailVerified,
}: RunnerPanelProps): React.JSX.Element | null {
  const [data, setData] = useState<GetRunnerStatusResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [pairing, setPairing] = useState<StartRunnerPairingResponse | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await runnerService.getStatus();
      setData(res);
    } catch {
      // Polling is background noise; only user-initiated actions surface errors.
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // Countdown for the pairing code. When it expires, clear the code so the user mints a fresh one.
  useEffect(() => {
    if (pairing === null) {
      setSecondsLeft(null);
      return;
    }
    const expiresAtMs = new Date(pairing.expiresAt).getTime();
    const tick = (): void => {
      const remaining = Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));
      setSecondsLeft(remaining);
      if (remaining === 0) {
        setPairing(null);
      }
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [pairing]);

  const startPairing = useCallback(async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const res = await runnerService.startPairing();
      setPairing(res);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const revoke = useCallback(
    async (device: RunnerDevice): Promise<void> => {
      setError(null);
      try {
        await runnerService.revokeDevice(device.id);
        await refresh();
      } catch (err) {
        setError(describeError(err));
      }
    },
    [refresh],
  );

  // Hide the card until the first fetch answers, and when the feature flag is off — an experimental
  // channel should not advertise itself on servers where it is disabled.
  if (!loaded || data === null) {
    return null;
  }

  if (!data.enabled) {
    return (
      <div className={styles.card}>
        <h2 className={styles.cardTitle}>
          Runners
          <span className={styles.badge}>Experimental</span>
        </h2>
        <p className={styles.muted}>Runners aren&rsquo;t available on this deployment.</p>
      </div>
    );
  }

  return (
    <div className={styles.card}>
      <h2 className={styles.cardTitle}>
        Runners
        <span className={styles.badge}>Experimental</span>
      </h2>

      <p className={styles.muted}>
        A Stewra Runner is a small process you run <strong>on your own machine</strong> that lets
        Stewra host coding agents against your repositories. Pair a machine to link it, and revoke it
        from here at any time to cut it off instantly.
      </p>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.actions}>
        <a
          className={styles.secondary}
          href={data.downloadUrl}
          target="_blank"
          rel="noreferrer"
        >
          Get the runner
        </a>
        <button
          type="button"
          className={styles.primary}
          disabled={busy || pairing !== null || !emailVerified}
          title={emailVerified ? undefined : 'Verify your email first'}
          onClick={() => void startPairing()}
        >
          Pair a machine
        </button>
      </div>

      {pairing !== null && (
        <div className={styles.pairingBox}>
          <div className={styles.pairingCode}>{pairing.code}</div>
          <p className={styles.mutedSmall}>
            On your machine, run <code className={styles.cmd}>stewra-runner pair {pairing.code}</code>{' '}
            (get the runner from{' '}
            <a href={pairing.downloadUrl} target="_blank" rel="noreferrer">
              the download page
            </a>
            ).
            {secondsLeft !== null && <> Expires in {secondsLeft}s.</>}
          </p>
        </div>
      )}

      {data.devices.length > 0 && (
        <ul className={styles.deviceList}>
          {data.devices.map((device) => (
            <li key={device.id} className={styles.deviceRow}>
              <span className={styles.deviceInfo}>
                <LaptopIcon size={16} className={styles.deviceIcon} />
                <strong>{device.name}</strong>
                <span className={styles.deviceMeta}>
                  {device.os} · v{device.appVersion}
                </span>
                <span className={styles.deviceState}>
                  <span className={device.online ? styles.dotOk : styles.dotIdle} />
                  {device.online ? 'Online' : 'Offline'}
                </span>
                <span className={styles.deviceMeta}>
                  Harnesses: {harnessLabel(device)} · {device.workspaces.length}{' '}
                  {device.workspaces.length === 1 ? 'workspace' : 'workspaces'}
                </span>
              </span>
              <button
                type="button"
                className={styles.ghost}
                onClick={() => void revoke(device)}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      {data.devices.length === 0 && (
        <p className={styles.mutedSmall}>
          No machine paired yet. Install the runner, then pair a machine.
        </p>
      )}
    </div>
  );
}
