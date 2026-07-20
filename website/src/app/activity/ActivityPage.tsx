import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  GMAIL_LOOKBACK_MIN_DAYS,
  GMAIL_LOOKBACK_MAX_DAYS,
  type AuditEvent,
  type Connection,
  type UserPreferences,
  type ResourceKind,
} from '@stewra/shared-types';
import { useAuth } from '../../hooks/useAuth';
import { api, ApiError } from '../../services/api';
import { AppNav } from '../../components/AppNav/AppNav';
import { FeedbackControl } from '../../components/FeedbackControl/FeedbackControl';
import WhatsappBridgePanel from './WhatsappBridgePanel';
import EmailOverWhatsappPanel from './EmailOverWhatsappPanel';
import RunnerPanel from './RunnerPanel';
import styles from './ActivityPage.module.css';

function describeError(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong';
}

export default function ActivityPage(): React.JSX.Element {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const emailVerified = user?.emailVerified ?? false;

  const [events, setEvents] = useState<ReadonlyArray<AuditEvent>>([]);
  const [connections, setConnections] = useState<ReadonlyArray<Connection>>([]);
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const [lookbackInput, setLookbackInput] = useState('');

  const [consentPrompt, setConsentPrompt] = useState<string | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [insight, setInsight] = useState<string | null>(null);
  const [insightId, setInsightId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const connectedParam = searchParams.get('connected');
  const justConnected = connectedParam === 'google';
  const connectFailed = connectedParam === 'error';

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [activity, conns, prefs] = await Promise.all([
        api.listActivity(),
        api.listConnections(),
        api.getPreferences(),
      ]);
      setEvents(activity.items);
      setConnections(conns.connections);
      setPreferences(prefs.preferences);
      setLookbackInput(String(prefs.preferences.gmailLookbackDays));
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Impression beacon: as soon as a fresh insight renders, tell the backend it was seen. Best-effort
  // telemetry — a failed beacon must never surface an error over the insight the user asked for.
  useEffect(() => {
    if (insightId === null) {
      return;
    }
    void api.markInsightSeen(insightId).catch(() => undefined);
  }, [insightId]);

  const startConnect = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const res = await api.startGoogleConnection();
      setConsentPrompt(res.consentPrompt);
      setAuthorizeUrl(res.authorizeUrl);
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  const approveConsent = useCallback((): void => {
    if (authorizeUrl !== null) {
      window.location.href = authorizeUrl;
    }
  }, [authorizeUrl]);

  const cancelConsent = useCallback((): void => {
    setConsentPrompt(null);
    setAuthorizeUrl(null);
  }, []);

  const disconnect = useCallback(
    async (id: string): Promise<void> => {
      setError(null);
      try {
        await api.disconnect(id);
        await refresh();
      } catch (err) {
        setError(describeError(err));
      }
    },
    [refresh],
  );

  const generate = useCallback(
    async (kind: ResourceKind): Promise<void> => {
      setError(null);
      setInsight(null);
      setInsightId(null);
      setBusy(true);
      try {
        const res = await api.generateInsight({ kind });
        setInsight(res.insight.summary);
        setInsightId(res.insightId);
        await refresh();
      } catch (err) {
        setError(describeError(err));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const saveLookback = useCallback(async (): Promise<void> => {
    setError(null);
    const days = Number(lookbackInput);
    if (!Number.isInteger(days) || days < GMAIL_LOOKBACK_MIN_DAYS || days > GMAIL_LOOKBACK_MAX_DAYS) {
      setError(`Choose a whole number of days between ${GMAIL_LOOKBACK_MIN_DAYS} and ${GMAIL_LOOKBACK_MAX_DAYS}.`);
      return;
    }
    try {
      const res = await api.updatePreferences({ gmailLookbackDays: days });
      setPreferences(res.preferences);
      setLookbackInput(String(res.preferences.gmailLookbackDays));
    } catch (err) {
      setError(describeError(err));
    }
  }, [lookbackInput]);

  const toggleSentMailLearning = useCallback(async (): Promise<void> => {
    if (!preferences) {
      return;
    }
    setError(null);
    try {
      const res = await api.updatePreferences({
        learnFromSentMail: !preferences.learnFromSentMail,
      });
      setPreferences(res.preferences);
    } catch (err) {
      setError(describeError(err));
    }
  }, [preferences]);

  const dismissInsight = useCallback(async (): Promise<void> => {
    const id = insightId;
    // Clear locally first so the card closes instantly; the beacon is a weak implicit-negative
    // signal the backend only applies when the insight was seen and never explicitly rated.
    setInsight(null);
    setInsightId(null);
    if (id === null) {
      return;
    }
    try {
      await api.markInsightDismissed(id);
      await refresh();
    } catch {
      // Dismiss telemetry is best-effort; the card is already gone locally.
    }
  }, [insightId, refresh]);

  const dismissConnected = useCallback((): void => {
    searchParams.delete('connected');
    setSearchParams(searchParams, { replace: true });
  }, [searchParams, setSearchParams]);

  return (
    <div className={styles.page}>
      <AppNav />

      {!emailVerified && (
        <div className={styles.verifyBanner} role="status">
          <span>
            Verify your email to connect accounts and ask for insights. We sent a code to{' '}
            <strong>{user?.email}</strong>.
          </span>
          <button
            type="button"
            className={styles.primary}
            onClick={() => navigate('/verify-email')}
          >
            Enter code
          </button>
        </div>
      )}
      {justConnected && (
        <div className={styles.banner} onClick={dismissConnected} role="status">
          ✓ Google account connected. Generate an insight below to see it in action.
        </div>
      )}
      {connectFailed && (
        <div className={styles.error} onClick={dismissConnected} role="alert">
          We couldn’t finish connecting your Google account. Nothing was changed — please try again.
        </div>
      )}
      {error && <div className={styles.error}>{error}</div>}
      {insight && (
        <div className={styles.insight}>
          <span className={styles.insightText}>💡 {insight}</span>
          <button
            type="button"
            className={styles.insightDismiss}
            aria-label="Dismiss insight"
            title="Dismiss"
            onClick={() => void dismissInsight()}
          >
            ✕
          </button>
        </div>
      )}
      {insightId !== null && <FeedbackControl key={insightId} insightId={insightId} />}

      <section className={styles.grid}>
        <div className={styles.col}>
          <div className={styles.card}>
            <h2 className={styles.cardTitle}>Your sources</h2>
            {connections.length === 0 && (
              <p className={styles.muted}>Nothing connected yet. Stewra can only read what you allow.</p>
            )}
            <ul className={styles.list}>
              {connections.map((c) => (
                <li key={c.id} className={styles.connRow}>
                  <span>
                    <strong>{c.accountEmail || c.provider}</strong>
                    <em className={c.status === 'active' ? styles.active : styles.revoked}>
                      {c.status}
                    </em>
                  </span>
                  {c.status === 'active' && (
                    <button
                      type="button"
                      className={styles.ghost}
                      onClick={() => void disconnect(c.id)}
                    >
                      Disconnect
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <button
              type="button"
              className={styles.primary}
              disabled={!emailVerified}
              title={emailVerified ? undefined : 'Verify your email first'}
              onClick={() => void startConnect()}
            >
              Connect a Google account
            </button>
          </div>

          <WhatsappBridgePanel emailVerified={emailVerified} />

          <EmailOverWhatsappPanel emailVerified={emailVerified} />

          <RunnerPanel emailVerified={emailVerified} />

          <div className={styles.card}>
            <h2 className={styles.cardTitle}>Gmail window</h2>
            <p className={styles.muted}>
              How many days of email Stewra looks back over when advising you.
            </p>
            <div className={styles.lookbackRow}>
              <input
                type="number"
                min={GMAIL_LOOKBACK_MIN_DAYS}
                max={GMAIL_LOOKBACK_MAX_DAYS}
                value={lookbackInput}
                onChange={(e) => setLookbackInput(e.target.value)}
                className={styles.numInput}
              />
              <span className={styles.muted}>days</span>
              <button type="button" className={styles.primary} onClick={() => void saveLookback()}>
                Save
              </button>
            </div>
            {preferences && (
              <p className={styles.mutedSmall}>Currently {preferences.gmailLookbackDays} days.</p>
            )}
          </div>

          <div className={styles.card}>
            <h2 className={styles.cardTitle}>Learn my writing style</h2>
            <p className={styles.muted}>
              Let Stewra study <strong>how</strong> you write from your own sent emails — your
              greeting, tone, and who you tend to CC — to shape better email advice. It keeps only the
              style (never the emails themselves), proposes what it notices for you to confirm, and
              forgets it all if you disconnect Google.
            </p>
            <label className={styles.toggleRow}>
              <input
                type="checkbox"
                checked={preferences?.learnFromSentMail ?? false}
                disabled={!preferences}
                onChange={() => void toggleSentMailLearning()}
              />
              <span>
                {preferences?.learnFromSentMail
                  ? 'On — learning style from your sent mail'
                  : 'Off — your sent mail is never read'}
              </span>
            </label>
          </div>

          <div className={styles.card}>
            <h2 className={styles.cardTitle}>Ask for an insight</h2>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.secondary}
                disabled={busy || !emailVerified}
                title={emailVerified ? undefined : 'Verify your email first'}
                onClick={() => void generate('calendar')}
              >
                Look at my calendar
              </button>
              <button
                type="button"
                className={styles.secondary}
                disabled={busy || !emailVerified}
                title={emailVerified ? undefined : 'Verify your email first'}
                onClick={() => void generate('gmail')}
              >
                Look at my inbox
              </button>
            </div>
          </div>
        </div>

        <div className={styles.col}>
          <div className={styles.card}>
            <h2 className={styles.cardTitle}>Activity</h2>
            <p className={styles.muted}>
              Everything Stewra does is recorded here — every read, insight, and connection.
            </p>
            <ul className={styles.feed}>
              {events.length === 0 && <li className={styles.muted}>No activity yet.</li>}
              {events.map((e) => (
                <li key={e.id} className={styles.feedRow}>
                  <span className={e.success ? styles.dotOk : styles.dotFail} />
                  <div>
                    <div className={styles.feedSummary}>{e.summary}</div>
                    <div className={styles.feedTime}>{new Date(e.createdAt).toLocaleString()}</div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {consentPrompt !== null && (
        <div className={styles.modalWrap} role="dialog" aria-modal="true">
          <div className={styles.modal}>
            <h3 className={styles.modalTitle}>One quick check</h3>
            <p className={styles.modalBody}>{consentPrompt}</p>
            <div className={styles.modalActions}>
              <button type="button" className={styles.ghost} onClick={cancelConsent}>
                Not now
              </button>
              <button type="button" className={styles.primary} onClick={approveConsent}>
                Yes, continue to Google
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
