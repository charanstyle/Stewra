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
import styles from './ActivityPage.module.css';

function describeError(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong';
}

export default function ActivityPage(): React.JSX.Element {
  const { user, logout } = useAuth();
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const justConnected = searchParams.get('connected') === 'google';

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
      setBusy(true);
      try {
        const res = await api.generateInsight({ kind });
        setInsight(res.insight.summary);
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

  const dismissConnected = useCallback((): void => {
    searchParams.delete('connected');
    setSearchParams(searchParams, { replace: true });
  }, [searchParams, setSearchParams]);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.brand}>Stewra</h1>
        <div className={styles.headerRight}>
          <span className={styles.who}>{user?.displayName}</span>
          <button type="button" className={styles.ghost} onClick={logout}>
            Sign out
          </button>
        </div>
      </header>

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
      {error && <div className={styles.error}>{error}</div>}
      {insight && <div className={styles.insight}>💡 {insight}</div>}

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
