import { useCallback, useEffect, useState } from 'react';
import type { GetEmailOverWhatsappResponse } from '@stewra/shared-types';
import { api, ApiError } from '../../services/api';
import { AlertTriangleIcon, MailIcon, EyeIcon, EyeOffIcon } from '../../components/icons/Icons';
import styles from './EmailOverWhatsappPanel.module.css';

function describeError(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong';
}

interface EmailOverWhatsappPanelProps {
  readonly emailVerified: boolean;
}

/**
 * The approve-to-send opt-in: whether the user may ask Stewra to send email FROM WhatsApp.
 *
 * The security model this UI enforces:
 *  - Turning it ON requires the account password, re-verified server-side — a WhatsApp message is a weaker
 *    proof of identity than signing in, so a WhatsApp-only attacker can never flip this on.
 *  - Turning it OFF removes a capability and needs no password (never make a safety switch hard to disable).
 *  - Even ON, nothing sends from here: Stewra drafts the mail and the user APPROVES it on a signed-in
 *    surface. This toggle only changes what Stewra says on WhatsApp and (soon) whether an approval push
 *    fires — never the send authority itself.
 */
export default function EmailOverWhatsappPanel({
  emailVerified,
}: EmailOverWhatsappPanelProps): React.JSX.Element | null {
  const [data, setData] = useState<GetEmailOverWhatsappResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [passwordOpen, setPasswordOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setData(await api.getEmailOverWhatsapp());
    } catch {
      // A background read failing shouldn't shout; user-initiated actions below surface their own errors.
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const enable = useCallback(async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await api.setEmailOverWhatsapp({ enabled: true, password });
      setPasswordOpen(false);
      setPassword('');
      setShowPassword(false);
      await refresh();
    } catch (err) {
      // Wrong password (401) or validation error lands here — shown inline, the modal stays open.
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }, [password, refresh]);

  const disable = useCallback(async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await api.setEmailOverWhatsapp({ enabled: false });
      await refresh();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const closeModal = useCallback((): void => {
    setPasswordOpen(false);
    setPassword('');
    setShowPassword(false);
    setError(null);
  }, []);

  // Hide the card until the first fetch answers, and whenever the server kill-switch is off — an
  // experimental capability should not advertise itself where the deploy has disabled it.
  if (!loaded || data === null || !data.enabled) {
    return null;
  }

  const optedIn = data.optedIn;

  return (
    <div className={styles.card}>
      <h2 className={styles.cardTitle}>
        <MailIcon size={18} className={styles.titleIcon} />
        Send email by WhatsApp
        <span className={styles.badge}>Experimental</span>
      </h2>

      <p className={styles.muted}>
        With this on, you can ask Stewra to send an email from WhatsApp — but it never sends on its
        own. Stewra drafts it and waits for you to <strong>approve</strong> it. Approving happens in
        Stewra (and, soon, on a notification you unlock) — never from WhatsApp alone, because a
        WhatsApp message is a weaker proof of &ldquo;it&rsquo;s you&rdquo; than signing in.
      </p>

      <div className={styles.risk}>
        <span className={styles.riskIcon}>
          <AlertTriangleIcon size={18} />
        </span>
        <p className={styles.riskText}>
          <strong>Turning this on requires your password.</strong> Residual risk: someone with your{' '}
          <em>unlocked</em> phone holding both WhatsApp and a signed-in Stewra could approve a send —
          so keep this off if that worries you. Turn it off anytime, no password needed.
        </p>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.toggleRow}>
        <span className={styles.state}>
          <span className={optedIn ? styles.dotOn : styles.dotOff} />
          {optedIn ? 'On — you can approve sends from WhatsApp' : 'Off'}
        </span>
        {optedIn ? (
          <button
            type="button"
            className={styles.ghost}
            disabled={busy}
            onClick={() => void disable()}
          >
            Turn off
          </button>
        ) : (
          <button
            type="button"
            className={styles.primary}
            disabled={busy || !emailVerified}
            title={emailVerified ? undefined : 'Verify your email first'}
            onClick={() => {
              setError(null);
              setPasswordOpen(true);
            }}
          >
            Turn on
          </button>
        )}
      </div>

      {passwordOpen && !optedIn && (
        <div className={styles.modal}>
          <p className={styles.mutedSmall}>Confirm your password to turn this on.</p>
          <div className={styles.passwordRow}>
            <input
              type={showPassword ? 'text' : 'password'}
              className={styles.textInput}
              value={password}
              autoComplete="current-password"
              placeholder="Your Stewra password"
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && password.length > 0 && !busy) void enable();
              }}
            />
            <button
              type="button"
              className={styles.reveal}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              onClick={() => setShowPassword((s) => !s)}
            >
              {showPassword ? <EyeOffIcon size={18} /> : <EyeIcon size={18} />}
            </button>
          </div>
          <div className={styles.actions}>
            <button type="button" className={styles.ghost} onClick={closeModal}>
              Cancel
            </button>
            <button
              type="button"
              className={styles.primary}
              disabled={password.length === 0 || busy}
              onClick={() => void enable()}
            >
              Turn on
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
