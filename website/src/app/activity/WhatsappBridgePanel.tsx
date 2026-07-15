import { useCallback, useEffect, useState } from 'react';
import {
  WHATSAPP_PERSONAL_CONSENT_SENTENCE,
  isConsentSentenceValid,
  type BridgeDevice,
  type BridgeWaState,
  type GetWhatsappPersonalResponse,
  type StartBridgePairingResponse,
} from '@stewra/shared-types';
import { api, ApiError } from '../../services/api';
import { AlertTriangleIcon, LaptopIcon } from '../../components/icons/Icons';
import styles from './WhatsappBridgePanel.module.css';

/** How often we re-fetch the channel status. There is no socket push for bridge state (yet) —
 * the bridge reports over the /bridge namespace and the server only persists it — so the live
 * connected dot is driven by polling this endpoint. */
const POLL_INTERVAL_MS = 5000;

const WA_STATE_LABELS: Record<BridgeWaState, string> = {
  disconnected: 'Disconnected',
  pairing: 'Pairing…',
  connecting: 'Connecting…',
  open: 'Connected',
  logged_out: 'Logged out — re-pair needed',
  banned: 'Banned by WhatsApp',
};

const WA_STATE_DOTS: Record<BridgeWaState, string> = {
  disconnected: styles.dotIdle,
  pairing: styles.dotBusy,
  connecting: styles.dotBusy,
  open: styles.dotOk,
  logged_out: styles.dotIdle,
  banned: styles.dotFail,
};

function describeError(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong';
}

interface WhatsappBridgePanelProps {
  readonly emailVerified: boolean;
}

export default function WhatsappBridgePanel({
  emailVerified,
}: WhatsappBridgePanelProps): React.JSX.Element | null {
  const [data, setData] = useState<GetWhatsappPersonalResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [consentOpen, setConsentOpen] = useState(false);
  const [typedSentence, setTypedSentence] = useState('');
  const [busy, setBusy] = useState(false);

  const [pairing, setPairing] = useState<StartBridgePairingResponse | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await api.getWhatsappPersonal();
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

  const grantConsent = useCallback(async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await api.grantWhatsappPersonalConsent({ sentence: typedSentence });
      setConsentOpen(false);
      setTypedSentence('');
      await refresh();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }, [typedSentence, refresh]);

  const startPairing = useCallback(async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const res = await api.startBridgePairing();
      setPairing(res);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const revoke = useCallback(
    async (device: BridgeDevice): Promise<void> => {
      setError(null);
      try {
        await api.revokeBridgeDevice(device.id);
        await refresh();
      } catch (err) {
        setError(describeError(err));
      }
    },
    [refresh],
  );

  // Hide the card entirely until the first fetch answers, and when the feature flag is off —
  // an experimental channel should not advertise itself on servers where it is disabled.
  if (!loaded || data === null || !data.enabled) {
    return null;
  }

  const hasConsent =
    data.consentVersion !== null && data.consentVersion >= data.currentConsentVersion;
  const sentenceValid = isConsentSentenceValid(typedSentence);

  return (
    <div className={styles.card}>
      <h2 className={styles.cardTitle}>
        WhatsApp — your own number
        <span className={styles.badge}>Experimental</span>
      </h2>

      <div className={styles.risk}>
        <span className={styles.riskIcon}>
          <AlertTriangleIcon size={18} />
        </span>
        <p className={styles.riskText}>
          This links your <strong>personal</strong> WhatsApp account using an unofficial method
          that WhatsApp does not permit.{' '}
          <strong>Your account can be permanently banned, and bans are usually not reversible.</strong>{' '}
          Only link an account you&rsquo;re willing to lose — your number is often your identity
          for bank codes and 2FA.
        </p>
      </div>

      <p className={styles.muted}>
        Stewra Bridge runs <strong>on your own computer</strong>. Your WhatsApp login never leaves
        it — Stewra&rsquo;s servers never connect to WhatsApp and never hold your session. Stewra
        only answers while the bridge is running, and it only ever sees your{' '}
        <em>Message yourself</em> chat unless you tick others. You&rsquo;ll see
        &ldquo;Stewra&nbsp;Bridge&rdquo; in WhatsApp → Linked Devices, and you can remove it from
        your phone at any time.
      </p>

      {error && <div className={styles.error}>{error}</div>}

      {!hasConsent && (
        <>
          {!consentOpen && (
            <button
              type="button"
              className={styles.secondary}
              disabled={!emailVerified}
              title={emailVerified ? undefined : 'Verify your email first'}
              onClick={() => setConsentOpen(true)}
            >
              I understand the risk — set it up
            </button>
          )}
          {consentOpen && (
            <div className={styles.consentBox}>
              <p className={styles.muted}>
                To continue, type this sentence exactly:
                <br />
                <strong className={styles.sentence}>
                  {WHATSAPP_PERSONAL_CONSENT_SENTENCE}
                </strong>
              </p>
              <input
                type="text"
                className={styles.textInput}
                value={typedSentence}
                placeholder="Type the sentence above"
                onChange={(e) => setTypedSentence(e.target.value)}
              />
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.ghost}
                  onClick={() => {
                    setConsentOpen(false);
                    setTypedSentence('');
                  }}
                >
                  Not now
                </button>
                <button
                  type="button"
                  className={styles.primary}
                  disabled={!sentenceValid || busy}
                  onClick={() => void grantConsent()}
                >
                  I accept the risk
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {hasConsent && (
        <>
          <div className={styles.actions}>
            <a
              className={styles.secondary}
              href={data.downloadUrl}
              target="_blank"
              rel="noreferrer"
            >
              Download Stewra Bridge
            </a>
            <button
              type="button"
              className={styles.primary}
              disabled={busy || pairing !== null}
              onClick={() => void startPairing()}
            >
              Generate pairing code
            </button>
          </div>

          {pairing !== null && (
            <div className={styles.pairingBox}>
              <div className={styles.pairingCode}>{pairing.code}</div>
              <p className={styles.mutedSmall}>
                Paste this code into Stewra Bridge on your computer.
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
                    <span className={styles.deviceState}>
                      <span className={WA_STATE_DOTS[device.waState]} />
                      {WA_STATE_LABELS[device.waState]}
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
              No bridge linked yet. Install Stewra Bridge, then generate a pairing code.
            </p>
          )}
        </>
      )}
    </div>
  );
}
