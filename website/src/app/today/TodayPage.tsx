import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import type { Briefing, Connection, Suggestion } from '@stewra/shared-types';
import { useAuth } from '../../hooks/useAuth';
import { api, ApiError } from '../../services/api';
import { AppNav } from '../../components/AppNav/AppNav';
import { BriefingCard } from './BriefingCard';
import { NudgeCard } from './NudgeCard';
import styles from './TodayPage.module.css';

function describeError(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong';
}

/** Time-of-day greeting for the page header. */
function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) {
    return 'Good morning';
  }
  if (hour < 18) {
    return 'Good afternoon';
  }
  return 'Good evening';
}

/**
 * The proactive-assistant home: a natural-language briefing followed by a stack of nudges — cases
 * where Stewra thinks action is needed. Each nudge expands into a decision prompt (NudgeCard). This
 * is the post-login landing page, replacing /activity in that role.
 */
export default function TodayPage(): React.JSX.Element {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [suggestions, setSuggestions] = useState<ReadonlyArray<Suggestion>>([]);
  const [connections, setConnections] = useState<ReadonlyArray<Connection>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // First-run onboarding: the backend's consent prompt, held for the modal before Google opens.
  const [consentPrompt, setConsentPrompt] = useState<string | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [computing, setComputing] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const [briefingRes, suggestionsRes, connectionsRes] = await Promise.all([
        api.getBriefing(),
        api.listSuggestions(),
        api.listConnections(),
      ]);
      setBriefing(briefingRes.briefing);
      setSuggestions(suggestionsRes.suggestions);
      setConnections(connectionsRes.connections);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onResolved = useCallback((id: string): void => {
    setSuggestions((prev) => prev.filter((s) => s.id !== id));
  }, []);

  /** Step 1 of onboarding: fetch the plain-language consent prompt, show it before Google opens. */
  const startConnect = useCallback(async (): Promise<void> => {
    setError(null);
    setConnecting(true);
    try {
      const res = await api.startGoogleConnection();
      setConsentPrompt(res.consentPrompt);
      setAuthorizeUrl(res.authorizeUrl);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setConnecting(false);
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

  /** Step 2: with a connection but no briefing yet, build the first one on demand. */
  const computeFirstBriefing = useCallback(async (): Promise<void> => {
    setError(null);
    setComputing(true);
    try {
      const res = await api.recomputeToday();
      setBriefing(res.briefing);
      const suggestionsRes = await api.listSuggestions();
      setSuggestions(suggestionsRes.suggestions);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setComputing(false);
    }
  }, []);

  const needsReconsent = connections.some((c) => c.needsReconsent);
  const firstName = user?.displayName.split(' ')[0] ?? '';

  return (
    <div className={styles.page}>
      <AppNav />

      <header className={styles.header}>
        <h1 className={styles.title}>
          {greeting()}
          {firstName ? `, ${firstName}` : ''}
        </h1>
        <p className={styles.subtitle}>Here’s what Stewra is watching for you today.</p>
      </header>

      {needsReconsent && (
        <div className={styles.reconsentBanner} role="status">
          <span>Reconnect Google to enable actions on your suggestions.</span>
          <button
            type="button"
            className={styles.primary}
            onClick={() => navigate('/activity')}
          >
            Reconnect
          </button>
        </div>
      )}

      {error !== null && <div className={styles.error}>{error}</div>}

      {loading ? (
        <p className={styles.muted}>Loading…</p>
      ) : connections.length === 0 ? (
        /* Cold start: no connections yet. One clear first step, honestly framed — Stewra is
           valuable with just the calendar, and further connections are earned, never demanded. */
        <section className={styles.onboarding}>
          <h2 className={styles.onboardingTitle}>Let’s get you a reason to come back tomorrow</h2>
          <p className={styles.onboardingBody}>
            Stewra works from sources you explicitly connect — nothing else. Start with just your
            Google calendar: that alone is enough for a daily look at your week, protected time, and
            conflicts worth knowing about.
          </p>
          <ul className={styles.onboardingList}>
            <li>Read-only to start — Stewra never acts without your explicit yes.</li>
            <li>Every read lands in your Activity feed, so you can always see what it looked at.</li>
            <li>One switch pauses everything; disconnecting revokes access at Google itself.</li>
          </ul>
          <button
            type="button"
            className={styles.primary}
            disabled={connecting}
            onClick={() => void startConnect()}
          >
            {connecting ? 'One moment…' : 'Connect Google Calendar'}
          </button>
          <p className={styles.onboardingFootnote}>
            Gmail, banking, and WhatsApp can come later, one at a time, if Stewra earns them.
          </p>
        </section>
      ) : briefing === null ? (
        /* Connected but nothing computed yet — make the value visible NOW, not at the next tick. */
        <section className={styles.onboarding}>
          <h2 className={styles.onboardingTitle}>You’re connected</h2>
          <p className={styles.onboardingBody}>
            Stewra will refresh this page on its own from here — but there’s no reason to wait for
            the first one.
          </p>
          <button
            type="button"
            className={styles.primary}
            disabled={computing}
            onClick={() => void computeFirstBriefing()}
          >
            {computing ? 'Building your briefing…' : 'Build my first briefing'}
          </button>
        </section>
      ) : (
        <>
          <BriefingCard briefing={briefing} />

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Needs your attention</h2>
            {suggestions.length === 0 ? (
              <div className={styles.empty}>You’re all caught up.</div>
            ) : (
              <div className={styles.stack}>
                {suggestions.map((s) => (
                  <NudgeCard key={s.id} suggestion={s} onResolved={onResolved} />
                ))}
              </div>
            )}
          </section>
        </>
      )}

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
