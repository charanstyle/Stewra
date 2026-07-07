import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
    </div>
  );
}
