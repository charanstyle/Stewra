import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { Link } from 'react-router';
import type {
  BroadcastRecipient,
  ChannelAccount,
  CommerceBroadcast,
  CommerceCostSummary,
  CommerceJob,
  CommerceJobStatus,
  CommerceSegment,
  MessageTemplate,
  PreviewBroadcastResponse,
} from '@stewra/shared-types';
import { MESSAGE_PRICING_CATEGORIES, roleMeetsMinimum } from '@stewra/shared-types';
import { AppNav } from '../../components/AppNav/AppNav';
import { api } from '../../services/api';
import { useCommerceOrg } from './useCommerceOrg';
import styles from './CommercePage.module.css';

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}

/** `datetime-local` value → ISO with the browser's offset, which the API requires. */
function toIso(local: string): string {
  return new Date(local).toISOString();
}

/** The default period the costs card asks about: the current calendar month so far. */
function monthStartLocal(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01T00:00`;
}

function nowLocal(): string {
  const now = new Date(Date.now() + 60_000);
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

/**
 * Campaigns: the approved message shapes, the scheduled sends, and what they cost.
 *
 * Templates here are a MIRROR of Meta's objects — status comes from Meta's approval pipeline, not
 * from anything this page does, which is why every template wears its status and a Sync button
 * exists. A broadcast can only pick an approved one, and the schedule field has no default: "send
 * now" is a time somebody typed, never an absence.
 */
export default function CampaignsPage(): React.JSX.Element {
  const { memberships, orgId, setOrgId, role, loadError } = useCommerceOrg();

  const [accounts, setAccounts] = useState<ReadonlyArray<ChannelAccount>>([]);
  const [templates, setTemplates] = useState<ReadonlyArray<MessageTemplate>>([]);
  const [segments, setSegments] = useState<ReadonlyArray<CommerceSegment>>([]);
  const [broadcasts, setBroadcasts] = useState<ReadonlyArray<CommerceBroadcast>>([]);
  const [jobs, setJobs] = useState<ReadonlyArray<CommerceJob>>([]);
  const [jobCounts, setJobCounts] = useState<Readonly<Record<CommerceJobStatus, number>> | null>(
    null,
  );

  // New template form.
  const [tplName, setTplName] = useState('');
  const [tplLanguage, setTplLanguage] = useState('en_US');
  const [tplCategory, setTplCategory] = useState<'marketing' | 'utility' | 'authentication'>(
    'marketing',
  );
  const [tplBody, setTplBody] = useState('');
  const [syncing, setSyncing] = useState(false);

  // New broadcast form.
  const [bcName, setBcName] = useState('');
  const [bcTemplateId, setBcTemplateId] = useState('');
  const [bcSegmentId, setBcSegmentId] = useState('');
  const [bcVariables, setBcVariables] = useState<string[]>([]);
  const [bcWhen, setBcWhen] = useState(nowLocal());
  const [preview, setPreview] = useState<PreviewBroadcastResponse | null>(null);

  const [openBroadcastId, setOpenBroadcastId] = useState<string | null>(null);
  const [recipients, setRecipients] = useState<ReadonlyArray<BroadcastRecipient>>([]);

  const [costs, setCosts] = useState<CommerceCostSummary | null>(null);
  const [costFrom, setCostFrom] = useState(monthStartLocal());
  const [costTo, setCostTo] = useState(nowLocal());

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selectedTemplate = templates.find((t) => t.id === bcTemplateId) ?? null;
  const approvedTemplates = templates.filter((t) => t.status === 'approved');
  const whatsappAccounts = accounts.filter(
    (a) => a.platform === 'whatsapp_cloud' && a.status === 'active',
  );
  const isMarketer = role !== null && roleMeetsMinimum(role, 'marketer');
  const isAdmin = role !== null && roleMeetsMinimum(role, 'admin');

  const loadAll = useCallback(async (id: string): Promise<void> => {
    try {
      const [channelsRes, templatesRes, segmentsRes, broadcastsRes, jobsRes] = await Promise.all([
        api.listChannelAccounts(id),
        api.listMessageTemplates(id),
        api.listCommerceSegments(id),
        api.listBroadcasts(id),
        api.listCommerceJobs(id, { limit: 25 }),
      ]);
      setAccounts(channelsRes.accounts);
      setTemplates(templatesRes.templates);
      setSegments(segmentsRes.segments);
      setBroadcasts(broadcastsRes.broadcasts);
      setJobs(jobsRes.jobs);
      setJobCounts(jobsRes.counts);
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    if (orgId === null) return;
    setPreview(null);
    setOpenBroadcastId(null);
    void loadAll(orgId);
  }, [orgId, loadAll]);

  // Keep the variable inputs in lockstep with the chosen template's declared count.
  useEffect(() => {
    const count = selectedTemplate?.variableCount ?? 0;
    setBcVariables((current) =>
      Array.from({ length: count }, (_, i) => current[i] ?? ''),
    );
  }, [selectedTemplate?.variableCount]);

  const createTemplate = useCallback(async (): Promise<void> => {
    if (orgId === null || whatsappAccounts[0] === undefined) return;
    setError(null);
    setNotice(null);
    try {
      const res = await api.createMessageTemplate(orgId, {
        channelAccountId: whatsappAccounts[0].id,
        name: tplName.trim(),
        language: tplLanguage.trim(),
        category: tplCategory,
        bodyText: tplBody,
      });
      setTplName('');
      setTplBody('');
      setNotice(
        `Submitted "${res.template.name}" to Meta. It is ${res.template.status} — Meta decides, ` +
          'usually within a day, and the status here updates on its own.',
      );
      await loadAll(orgId);
    } catch (err) {
      setError(describeError(err));
    }
  }, [orgId, whatsappAccounts, tplName, tplLanguage, tplCategory, tplBody, loadAll]);

  const syncTemplates = useCallback(async (): Promise<void> => {
    if (orgId === null || whatsappAccounts[0] === undefined) return;
    setError(null);
    setSyncing(true);
    try {
      const res = await api.syncMessageTemplates(orgId, {
        channelAccountId: whatsappAccounts[0].id,
      });
      setNotice(
        res.changed.length === 0
          ? `Checked ${res.synced} template(s) against Meta — nothing changed.`
          : `Checked ${res.synced} template(s): ${res.changed
              .map((t) => `${t.name} is now ${t.status}`)
              .join(', ')}.`,
      );
      await loadAll(orgId);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSyncing(false);
    }
  }, [orgId, whatsappAccounts, loadAll]);

  const deleteTemplate = useCallback(
    async (templateId: string): Promise<void> => {
      if (orgId === null) return;
      setError(null);
      try {
        await api.deleteMessageTemplate(orgId, templateId);
        await loadAll(orgId);
      } catch (err) {
        setError(describeError(err));
      }
    },
    [orgId, loadAll],
  );

  const previewCampaign = useCallback(async (): Promise<void> => {
    if (orgId === null || bcSegmentId === '' || bcTemplateId === '') return;
    setError(null);
    try {
      const res = await api.previewBroadcast(orgId, {
        segmentId: bcSegmentId,
        templateId: bcTemplateId,
      });
      setPreview(res);
    } catch (err) {
      setError(describeError(err));
    }
  }, [orgId, bcSegmentId, bcTemplateId]);

  const schedule = useCallback(async (): Promise<void> => {
    if (orgId === null || selectedTemplate === null) return;
    setError(null);
    setNotice(null);
    try {
      const res = await api.createBroadcast(orgId, {
        name: bcName.trim(),
        channelAccountId: selectedTemplate.channelAccountId,
        segmentId: bcSegmentId,
        templateId: bcTemplateId,
        variables: bcVariables,
        scheduledFor: toIso(bcWhen),
      });
      setBcName('');
      setPreview(null);
      setNotice(
        `Scheduled "${res.broadcast.name}" for ${new Date(res.broadcast.scheduledFor).toLocaleString()}. ` +
          'The audience is resolved when it runs, not now.',
      );
      await loadAll(orgId);
    } catch (err) {
      setError(describeError(err));
    }
  }, [orgId, selectedTemplate, bcName, bcSegmentId, bcTemplateId, bcVariables, bcWhen, loadAll]);

  const cancelBroadcast = useCallback(
    async (broadcastId: string): Promise<void> => {
      if (orgId === null) return;
      setError(null);
      try {
        const res = await api.cancelBroadcast(orgId, broadcastId);
        setNotice(
          res.broadcast.sentCount > 0
            ? `Cancelled. ${res.broadcast.sentCount} message(s) had already gone out and cannot be unsent.`
            : 'Cancelled before anything was sent.',
        );
        await loadAll(orgId);
      } catch (err) {
        setError(describeError(err));
      }
    },
    [orgId, loadAll],
  );

  const resumeBroadcast = useCallback(
    async (broadcastId: string): Promise<void> => {
      if (orgId === null) return;
      setError(null);
      try {
        await api.resumeBroadcast(orgId, broadcastId);
        setNotice('Resumed. Sending continues from where it paused.');
        await loadAll(orgId);
      } catch (err) {
        setError(describeError(err));
      }
    },
    [orgId, loadAll],
  );

  const openRecipients = useCallback(
    async (broadcastId: string): Promise<void> => {
      if (orgId === null) return;
      if (openBroadcastId === broadcastId) {
        setOpenBroadcastId(null);
        return;
      }
      setError(null);
      setOpenBroadcastId(broadcastId);
      setRecipients([]);
      try {
        const res = await api.listBroadcastRecipients(orgId, broadcastId, { limit: 100 });
        setRecipients(res.recipients);
      } catch (err) {
        setError(describeError(err));
      }
    },
    [orgId, openBroadcastId],
  );

  const loadCosts = useCallback(async (): Promise<void> => {
    if (orgId === null) return;
    setError(null);
    try {
      const res = await api.getCommerceCosts(orgId, {
        from: toIso(costFrom),
        to: toIso(costTo),
      });
      setCosts(res.summary);
    } catch (err) {
      setError(describeError(err));
    }
  }, [orgId, costFrom, costTo]);

  return (
    <div className={styles.page}>
      <AppNav />
      <main className={styles.main}>
        <h1 className={styles.title}>Campaigns</h1>
        <p className={styles.subtitle}>
          Approved message templates, scheduled broadcasts, and what Meta charged. Who they reach is
          decided on <Link to="/commerce/audience">the audience page</Link>.
        </p>

        {(error ?? loadError) !== null && <div className={styles.error}>{error ?? loadError}</div>}
        {notice !== null && <div className={styles.notice}>{notice}</div>}

        {memberships.length > 1 && (
          <section className={styles.card}>
            <select
              className={styles.select}
              value={orgId ?? ''}
              onChange={(e) => setOrgId(e.target.value)}
            >
              {memberships.map((m) => (
                <option key={m.org.id} value={m.org.id}>
                  {m.org.name} · {m.role}
                </option>
              ))}
            </select>
          </section>
        )}

        {orgId !== null && whatsappAccounts.length === 0 && (
          <section className={styles.card}>
            <p className={styles.muted}>
              No active WhatsApp number. <Link to="/commerce">Connect one</Link> before building
              campaigns — templates and broadcasts both live on the number.
            </p>
          </section>
        )}

        {orgId !== null && whatsappAccounts.length > 0 && (
          <>
            <section className={styles.card}>
              <h2 className={styles.cardTitle}>Templates</h2>
              <p className={styles.muted}>
                Meta owns these: it approves, re-categorizes, and pauses them, and only an approved
                template can be sent to someone who has not messaged you in the last 24 hours.
              </p>
              {templates.length > 0 && (
                <ul className={styles.list}>
                  {templates.map((template) => (
                    <li key={template.id} className={styles.listRow}>
                      <span>
                        {template.name} · {template.language}{' '}
                        <span
                          className={clsx(
                            styles.tag,
                            template.status !== 'approved' && styles.tagWarn,
                          )}
                        >
                          {template.status}
                        </span>{' '}
                        <span className={styles.tag}>
                          {template.category ?? `unrecognized: ${template.providerCategory ?? '?'}`}
                        </span>
                        {template.rejectionReason !== null && (
                          <span className={styles.muted}> — {template.rejectionReason}</span>
                        )}
                        <br />
                        <span className={styles.muted}>{template.bodyText}</span>
                      </span>
                      {isMarketer && (
                        <button
                          type="button"
                          className={styles.ghost}
                          onClick={() => void deleteTemplate(template.id)}
                        >
                          Delete
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {isMarketer && (
                <>
                  <div className={styles.row}>
                    <input
                      className={styles.input}
                      placeholder="name_like_this"
                      value={tplName}
                      onChange={(e) => setTplName(e.target.value)}
                    />
                    <input
                      className={styles.input}
                      placeholder="Language (en_US)"
                      value={tplLanguage}
                      onChange={(e) => setTplLanguage(e.target.value)}
                    />
                    <select
                      className={styles.select}
                      value={tplCategory}
                      onChange={(e) => {
                        const value = e.target.value;
                        if (
                          value === 'marketing' ||
                          value === 'utility' ||
                          value === 'authentication'
                        ) {
                          setTplCategory(value);
                        }
                      }}
                    >
                      <option value="marketing">marketing</option>
                      <option value="utility">utility</option>
                      <option value="authentication">authentication</option>
                    </select>
                  </div>
                  <div className={styles.row}>
                    <input
                      className={styles.input}
                      placeholder="Body — placeholders like {{1}} become per-campaign values"
                      value={tplBody}
                      onChange={(e) => setTplBody(e.target.value)}
                    />
                    <button
                      type="button"
                      className={styles.primary}
                      disabled={tplName.trim() === '' || tplBody.trim() === ''}
                      onClick={() => void createTemplate()}
                    >
                      Submit to Meta
                    </button>
                    <button
                      type="button"
                      className={styles.ghost}
                      disabled={syncing}
                      onClick={() => void syncTemplates()}
                    >
                      {syncing ? 'Checking…' : 'Check Meta now'}
                    </button>
                  </div>
                </>
              )}
            </section>

            <section className={styles.card}>
              <h2 className={styles.cardTitle}>Broadcasts</h2>
              {broadcasts.length > 0 && (
                <ul className={styles.list}>
                  {broadcasts.map((broadcast) => (
                    <li key={broadcast.id}>
                      <div className={styles.listRow}>
                        <span>
                          {broadcast.name}{' '}
                          <span
                            className={clsx(
                              styles.tag,
                              (broadcast.status === 'failed' || broadcast.status === 'cancelled') &&
                                styles.tagError,
                              broadcast.status === 'paused' && styles.tagWarn,
                            )}
                          >
                            {broadcast.status}
                          </span>
                          <span className={styles.muted}>
                            {' '}
                            · {new Date(broadcast.scheduledFor).toLocaleString()}
                            {broadcast.totalRecipients > 0 &&
                              ` · ${broadcast.sentCount}/${broadcast.totalRecipients} sent` +
                                (broadcast.skippedCount > 0
                                  ? `, ${broadcast.skippedCount} skipped`
                                  : '') +
                                (broadcast.failedCount > 0
                                  ? `, ${broadcast.failedCount} failed`
                                  : '')}
                            {broadcast.lastError !== null && ` — ${broadcast.lastError}`}
                          </span>
                        </span>
                        <span>
                          <button
                            type="button"
                            className={styles.ghost}
                            onClick={() => void openRecipients(broadcast.id)}
                          >
                            Recipients
                          </button>
                          {isAdmin && broadcast.status === 'paused' && (
                            <button
                              type="button"
                              className={styles.ghost}
                              onClick={() => void resumeBroadcast(broadcast.id)}
                            >
                              Resume
                            </button>
                          )}
                          {isAdmin &&
                            (broadcast.status === 'scheduled' ||
                              broadcast.status === 'running' ||
                              broadcast.status === 'paused') && (
                              <button
                                type="button"
                                className={styles.ghost}
                                onClick={() => void cancelBroadcast(broadcast.id)}
                              >
                                Cancel
                              </button>
                            )}
                        </span>
                      </div>
                      {broadcast.id === openBroadcastId && (
                        <ul className={styles.list}>
                          {recipients.length === 0 ? (
                            <li className={styles.muted}>
                              Nobody yet — recipients are chosen when the broadcast dispatches.
                            </li>
                          ) : (
                            recipients.map((recipient) => (
                              <li key={recipient.id} className={styles.muted}>
                                {recipient.displayName ?? `+${recipient.externalId}`} —{' '}
                                {recipient.status}
                                {recipient.reason !== null && ` (${recipient.reason})`}
                              </li>
                            ))
                          )}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {isAdmin && (
                <>
                  <div className={styles.row}>
                    <input
                      className={styles.input}
                      placeholder="Campaign name"
                      value={bcName}
                      onChange={(e) => setBcName(e.target.value)}
                    />
                    <select
                      className={styles.select}
                      value={bcSegmentId}
                      onChange={(e) => setBcSegmentId(e.target.value)}
                    >
                      <option value="">To segment…</option>
                      {segments.map((segment) => (
                        <option key={segment.id} value={segment.id}>
                          {segment.name}
                        </option>
                      ))}
                    </select>
                    <select
                      className={styles.select}
                      value={bcTemplateId}
                      onChange={(e) => setBcTemplateId(e.target.value)}
                    >
                      <option value="">Using template…</option>
                      {approvedTemplates.map((template) => (
                        <option key={template.id} value={template.id}>
                          {template.name} ({template.language})
                        </option>
                      ))}
                    </select>
                  </div>
                  {selectedTemplate !== null && selectedTemplate.variableCount > 0 && (
                    <div className={styles.row}>
                      {bcVariables.map((value, index) => (
                        <input
                          // Positional by definition: these inputs ARE {{1}}..{{n}}, so the index is
                          // the identity, not a stand-in for one. (No react plugin is configured in
                          // eslint.config.mjs, so a disable directive for react/no-array-index-key
                          // is itself an error for naming a rule that does not exist.)
                          key={index}
                          className={styles.input}
                          placeholder={`Value for {{${index + 1}}}`}
                          value={value}
                          onChange={(e) =>
                            setBcVariables((current) =>
                              current.map((v, i) => (i === index ? e.target.value : v)),
                            )
                          }
                        />
                      ))}
                    </div>
                  )}
                  <div className={styles.row}>
                    <input
                      className={styles.input}
                      type="datetime-local"
                      value={bcWhen}
                      onChange={(e) => setBcWhen(e.target.value)}
                    />
                    <button
                      type="button"
                      className={styles.ghost}
                      disabled={bcSegmentId === '' || bcTemplateId === ''}
                      onClick={() => void previewCampaign()}
                    >
                      Preview reach
                    </button>
                    <button
                      type="button"
                      className={styles.primary}
                      disabled={
                        bcName.trim() === '' ||
                        bcSegmentId === '' ||
                        bcTemplateId === '' ||
                        bcWhen === '' ||
                        bcVariables.some((v) => v.trim() === '')
                      }
                      onClick={() => void schedule()}
                    >
                      Schedule
                    </button>
                  </div>
                  {preview !== null && (
                    <p className={styles.muted}>
                      {preview.audience.total} selected, {preview.forecast.billableMessages} will be
                      billed
                      {preview.forecast.category !== null &&
                        ` as ${preview.forecast.category} messages`}
                      {Object.entries(preview.forecast.byCountryCode)
                        .map(([code, count]) => ` · ${count} to +${code}`)
                        .join('')}
                      . Meta publishes the per-country rates; no price is invented here.
                    </p>
                  )}
                </>
              )}
              {!isAdmin && (
                <p className={styles.muted}>
                  Scheduling a broadcast needs the admin role — it spends the organization&apos;s
                  money.
                </p>
              )}
            </section>

            <section className={styles.card}>
              <h2 className={styles.cardTitle}>Message costs</h2>
              <div className={styles.row}>
                <input
                  className={styles.input}
                  type="datetime-local"
                  value={costFrom}
                  onChange={(e) => setCostFrom(e.target.value)}
                />
                <input
                  className={styles.input}
                  type="datetime-local"
                  value={costTo}
                  onChange={(e) => setCostTo(e.target.value)}
                />
                <button
                  type="button"
                  className={styles.ghost}
                  disabled={!isAdmin}
                  onClick={() => void loadCosts()}
                >
                  {isAdmin ? 'Show what Meta charged' : 'Admins only'}
                </button>
              </div>
              {costs !== null && (
                <ul className={styles.list}>
                  {MESSAGE_PRICING_CATEGORIES.map((category) => (
                    <li key={category} className={styles.muted}>
                      {category}: {costs.billableByCategory[category]} billable message(s)
                    </li>
                  ))}
                  {costs.billableUncategorized > 0 && (
                    <li className={styles.muted}>
                      {costs.billableUncategorized} charged under a category Meta added that this
                      build cannot name yet — counted, not dropped.
                    </li>
                  )}
                  <li className={styles.muted}>{costs.freeMessages} free message(s)</li>
                  {costs.unpricedMessages > 0 && (
                    <li className={styles.muted}>
                      {costs.unpricedMessages} sent message(s) with no pricing reported yet — Meta
                      will bill these; close the period after they settle.
                    </li>
                  )}
                </ul>
              )}
              <p className={styles.muted}>
                Messages are billed straight through at Meta&apos;s price — Stewra takes no margin on
                them.
              </p>
            </section>

            <section className={styles.card}>
              <h2 className={styles.cardTitle}>Background work</h2>
              {jobCounts !== null && (
                <p className={styles.muted}>
                  {jobCounts.queued} queued · {jobCounts.running} running · {jobCounts.done} done ·{' '}
                  {jobCounts.failed} refused · {jobCounts.dead} gave up
                </p>
              )}
              {jobs.length > 0 && (
                <ul className={styles.list}>
                  {jobs.map((job) => (
                    <li key={job.id} className={styles.muted}>
                      {job.kind}{' '}
                      <span
                        className={clsx(
                          styles.tag,
                          (job.status === 'failed' || job.status === 'dead') && styles.tagError,
                        )}
                      >
                        {job.status}
                      </span>{' '}
                      · attempt {job.attempts}/{job.maxAttempts} ·{' '}
                      {new Date(job.createdAt).toLocaleString()}
                      {job.lastError !== null && ` — ${job.lastError}`}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
