import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type {
  AgentMemory,
  ListMemoriesRequest,
  ProcessRule,
  UpdateMemoryRequest,
  UpdateProcessRuleRequest,
} from '@stewra/shared-types';
import { api, ApiError } from '../../services/api';
import { MemoryCard } from './MemoryCard';
import { ProcessRuleCard } from './ProcessRuleCard';
import styles from './MemoryPage.module.css';

/** The kinds a memory can be scoped to (matches the backend's memory filter). */
type ScopeKind = 'calendar' | 'gmail' | 'money';
const SCOPE_KINDS: ReadonlyArray<ScopeKind> = ['calendar', 'gmail', 'money'];

function parseKind(value: string): ScopeKind | '' {
  return value === 'calendar' || value === 'gmail' || value === 'money' ? value : '';
}

function describeError(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong';
}

export default function MemoryPage(): React.JSX.Element {
  const navigate = useNavigate();

  const [memories, setMemories] = useState<ReadonlyArray<AgentMemory>>([]);
  const [rules, setRules] = useState<ReadonlyArray<ProcessRule>>([]);
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<ScopeKind | ''>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const trimmed = search.trim();
      const memoryParams: ListMemoriesRequest = {
        ...(trimmed.length > 0 ? { search: trimmed } : {}),
        ...(kind !== '' ? { kind } : {}),
      };
      const [memoryRes, ruleRes] = await Promise.all([
        api.listMemories(memoryParams),
        api.listProcessRules(trimmed.length > 0 ? { search: trimmed } : {}),
      ]);
      setMemories(memoryRes.memories);
      setRules(ruleRes.rules);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [search, kind]);

  // Debounce so typing in the search box doesn't fire a request per keystroke.
  useEffect(() => {
    const handle = setTimeout(() => {
      void load();
    }, 250);
    return () => clearTimeout(handle);
  }, [load]);

  const onUpdate = useCallback(
    async (id: string, patch: UpdateMemoryRequest): Promise<void> => {
      const res = await api.updateMemory(id, patch);
      setMemories((prev) => prev.map((m) => (m.id === id ? res.memory : m)));
    },
    [],
  );

  const onDelete = useCallback(async (id: string): Promise<void> => {
    await api.deleteMemory(id);
    setMemories((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const onUpdateRule = useCallback(
    async (id: string, patch: UpdateProcessRuleRequest): Promise<void> => {
      const res = await api.updateProcessRule(id, patch);
      setRules((prev) => prev.map((r) => (r.id === id ? res.rule : r)));
    },
    [],
  );

  const onDeleteRule = useCallback(async (id: string): Promise<void> => {
    await api.deleteProcessRule(id);
    setRules((prev) => prev.filter((r) => r.id !== id));
  }, []);

  // Proposals are Stewra asking permission; everything else is already the user's confirmed profile.
  const proposedRules = rules.filter((r) => r.status === 'proposed');
  const settledRules = rules.filter((r) => r.status !== 'proposed');

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>What Stewra has learned about you</h1>
        <button type="button" className={styles.ghost} onClick={() => navigate('/activity')}>
          Back
        </button>
      </header>

      <p className={styles.subtitle}>
        Everything here comes from your feedback. It’s yours — rename it, edit the guidance, hide it
        from recall, or delete it. Stewra replays these to do better on similar tasks.
      </p>

      <div className={styles.controls}>
        <input
          type="search"
          className={styles.search}
          placeholder="Search by name, purpose, or guidance…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className={styles.select}
          value={kind}
          aria-label="Filter by source"
          onChange={(e) => setKind(parseKind(e.target.value))}
        >
          <option value="">All sources</option>
          {SCOPE_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </div>

      {error !== null && <div className={styles.error}>{error}</div>}

      {loading ? (
        <p className={styles.muted}>Loading…</p>
      ) : (
        <>
          {proposedRules.length > 0 && (
            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>Things Stewra noticed — confirm or dismiss</h2>
              <p className={styles.muted}>
                Stewra spotted these patterns in how you like work done. Nothing is applied until you
                confirm it.
              </p>
              <div className={styles.list}>
                {proposedRules.map((r) => (
                  <ProcessRuleCard
                    key={r.id}
                    rule={r}
                    onUpdate={onUpdateRule}
                    onDelete={onDeleteRule}
                  />
                ))}
              </div>
            </section>
          )}

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>How you like your email done</h2>
            {settledRules.length === 0 ? (
              <p className={styles.muted}>
                No confirmed style rules yet. Turn on “Learn my writing style” to let Stewra propose
                some from your sent mail.
              </p>
            ) : (
              <div className={styles.list}>
                {settledRules.map((r) => (
                  <ProcessRuleCard
                    key={r.id}
                    rule={r}
                    onUpdate={onUpdateRule}
                    onDelete={onDeleteRule}
                  />
                ))}
              </div>
            )}
          </section>

          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>What worked before</h2>
            {memories.length === 0 ? (
              <div className={styles.empty}>
                Nothing learned yet. Rate an insight highly (or leave a note) and it’ll show up here.
              </div>
            ) : (
              <div className={styles.list}>
                {memories.map((m) => (
                  <MemoryCard key={m.id} memory={m} onUpdate={onUpdate} onDelete={onDelete} />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
