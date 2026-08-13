import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { Link } from 'react-router';
import type {
  AudiencePreview,
  ChannelAccount,
  CommerceContactWithTags,
  CommerceSegment,
  CommerceTag,
  ConsentPurpose,
  ConsentSource,
  OptinLink,
  ContactConsent,
  ContactImport,
  ContactImportRow,
  MessagingPolicy,
  SegmentDefinition,
  Suppression,
} from '@stewra/shared-types';
import { AUDIENCE_BLOCK_REASONS, roleMeetsMinimum } from '@stewra/shared-types';
import { AppNav } from '../../components/AppNav/AppNav';
import { api } from '../../services/api';
import { useCommerceOrg } from './useCommerceOrg';
import styles from './CommercePage.module.css';

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}

/**
 * The exact sentence an owner signs. Shown in full before the button, sent verbatim, and stored
 * verbatim — if this wording changes next quarter, existing attestations still prove what was
 * actually agreed to.
 */
const ATTESTATION_TEXT =
  'I attest that this organization holds documented, lawful opt-in for every contact it sends ' +
  'marketing messages to, and that it honors opt-outs immediately.';

/**
 * The consent sources a member can assert from this screen, and what each one is called here.
 *
 * `inbound_message` and `keyword` are deliberately absent: those are recorded by the customer's own
 * action, and a person is the proof. Offering them in a dropdown would let a member claim the
 * strongest, self-evidencing kind of consent for something nobody can go back and read.
 */
const SELECTABLE_CONSENT_SOURCES: ReadonlyArray<{ value: ConsentSource; label: string }> = [
  { value: 'web_form', label: 'Sign-up form' },
  { value: 'ad_click', label: 'Clicked an ad' },
  { value: 'import', label: 'Imported list' },
  { value: 'attested', label: 'Held on file elsewhere' },
];

/** Narrow a `<select>` value without asserting: an unknown string falls back to the first option. */
function toConsentSource(value: string): ConsentSource {
  return SELECTABLE_CONSENT_SOURCES.find((s) => s.value === value)?.value ?? 'web_form';
}

const BLOCK_REASON_LABELS: Record<(typeof AUDIENCE_BLOCK_REASONS)[number], string> = {
  suppressed: 'on the suppression list',
  platform_inbound_only: 'on a reply-only platform',
  no_marketing_consent: 'no marketing consent on file',
  marketing_opted_out: 'opted out of marketing',
};

/**
 * Who a campaign can reach, and the permission layer that decides it.
 *
 * Everything here exists in service of one rule the backend enforces and this page makes visible:
 * a segment names people, it never grants permission to message them. The audience numbers shown
 * next to every rule are split into "selected" and "reachable" so the gap — the people a broadcast
 * will silently skip — is on screen before anyone schedules anything.
 */
export default function AudiencePage(): React.JSX.Element {
  const { memberships, orgId, setOrgId, role, loadError } = useCommerceOrg();

  const [policy, setPolicy] = useState<MessagingPolicy | null>(null);
  const [timezone, setTimezone] = useState('');
  const [quietStart, setQuietStart] = useState('21:00');
  const [quietEnd, setQuietEnd] = useState('09:00');

  const [contacts, setContacts] = useState<ReadonlyArray<CommerceContactWithTags>>([]);
  const [search, setSearch] = useState('');
  const [openContactId, setOpenContactId] = useState<string | null>(null);
  const [consents, setConsents] = useState<ReadonlyArray<ContactConsent>>([]);
  const [consentEvidence, setConsentEvidence] = useState('');
  const [newTag, setNewTag] = useState('');

  const [newPhone, setNewPhone] = useState('');
  const [newName, setNewName] = useState('');
  const [newTags, setNewTags] = useState('');
  const [newConsent, setNewConsent] = useState(false);
  const [newConsentSource, setNewConsentSource] = useState<ConsentSource>('web_form');
  const [newConsentEvidence, setNewConsentEvidence] = useState('');
  const [adding, setAdding] = useState(false);

  const [importFile, setImportFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [activeImport, setActiveImport] = useState<ContactImport | null>(null);
  const [skippedRows, setSkippedRows] = useState<ReadonlyArray<ContactImportRow>>([]);
  const [skippedTruncated, setSkippedTruncated] = useState(false);

  const [optinLinks, setOptinLinks] = useState<ReadonlyArray<OptinLink>>([]);
  const [channelAccounts, setChannelAccounts] = useState<ReadonlyArray<ChannelAccount>>([]);
  const [linkChannelId, setLinkChannelId] = useState('');
  const [linkName, setLinkName] = useState('');
  const [linkPurpose, setLinkPurpose] = useState<ConsentPurpose>('marketing');
  const [linkPhrase, setLinkPhrase] = useState('Yes, please send me offers and updates');
  const [mintingLink, setMintingLink] = useState(false);
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null);

  const [tags, setTags] = useState<ReadonlyArray<CommerceTag>>([]);

  const [segments, setSegments] = useState<ReadonlyArray<CommerceSegment>>([]);
  const [segmentName, setSegmentName] = useState('');
  const [ruleTag, setRuleTag] = useState('');
  const [preview, setPreview] = useState<AudiencePreview | null>(null);
  const [previewedSegmentId, setPreviewedSegmentId] = useState<string | null>(null);

  const [suppressions, setSuppressions] = useState<ReadonlyArray<Suppression>>([]);
  const [suppressNumber, setSuppressNumber] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadAll = useCallback(async (id: string): Promise<void> => {
    try {
      const [
        policyRes,
        contactsRes,
        tagsRes,
        segmentsRes,
        suppressionsRes,
        linksRes,
        channelsRes,
      ] = await Promise.all([
        api.getMessagingPolicy(id),
        api.listCommerceContacts(id, { limit: 50 }),
        api.listCommerceTags(id),
        api.listCommerceSegments(id),
        api.listSuppressions(id, { limit: 50 }),
        api.listOptinLinks(id),
        api.listChannelAccounts(id),
      ]);
      setPolicy(policyRes.policy);
      if (policyRes.policy !== null) {
        setTimezone(policyRes.policy.timezone);
        setQuietStart(policyRes.policy.quietHoursStart);
        setQuietEnd(policyRes.policy.quietHoursEnd);
      }
      setContacts(contactsRes.contacts);
      setTags(tagsRes.tags);
      setSegments(segmentsRes.segments);
      setSuppressions(suppressionsRes.suppressions);
      setOptinLinks(linksRes.links);
      setChannelAccounts(channelsRes.accounts);
      // Preselect when there is exactly one connected number, which is the ordinary case. With two,
      // the operator has to say which one the sticker points at — guessing would print the wrong one.
      const only = channelsRes.accounts.length === 1 ? channelsRes.accounts[0] : undefined;
      if (only !== undefined) setLinkChannelId(only.id);
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    if (orgId === null) return;
    setOpenContactId(null);
    setPreview(null);
    setPreviewedSegmentId(null);
    void loadAll(orgId);
  }, [orgId, loadAll]);

  const searchContacts = useCallback(async (): Promise<void> => {
    if (orgId === null) return;
    setError(null);
    try {
      const res = await api.listCommerceContacts(orgId, {
        limit: 50,
        ...(search.trim() === '' ? {} : { search: search.trim() }),
      });
      setContacts(res.contacts);
    } catch (err) {
      setError(describeError(err));
    }
  }, [orgId, search]);

  /**
   * Add a contact the organization already holds.
   *
   * The consent half is optional on purpose, and the copy says what omitting it means rather than
   * leaving the operator to find out from a broadcast that skipped them. Recording an opt-in here is
   * a claim about something that happened elsewhere — so the evidence box is required the moment the
   * box is ticked, and the source names which kind of proof it is.
   */
  const addContact = useCallback(async (): Promise<void> => {
    if (orgId === null || newPhone.trim() === '') return;
    setError(null);
    setNotice(null);
    setAdding(true);
    try {
      const res = await api.createCommerceContact(orgId, {
        phoneE164: newPhone.trim(),
        ...(newName.trim() === '' ? {} : { displayName: newName.trim() }),
        tags: newTags
          .split(',')
          .map((tag) => tag.trim())
          .filter((tag) => tag !== ''),
        ...(newConsent
          ? {
              consent: {
                purpose: 'marketing' as const,
                state: 'opted_in' as const,
                source: newConsentSource,
                evidence: newConsentEvidence.trim(),
              },
            }
          : {}),
      });
      setNewPhone('');
      setNewName('');
      setNewTags('');
      setNewConsent(false);
      setNewConsentEvidence('');
      setNotice(
        res.consent === null
          ? `${res.contact.phoneE164 ?? 'Contact'} added. Marketing cannot reach them until an ` +
            'opt-in is on file.'
          : `${res.contact.phoneE164 ?? 'Contact'} added with marketing opt-in recorded.`,
      );
      await loadAll(orgId);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setAdding(false);
    }
  }, [orgId, newPhone, newName, newTags, newConsent, newConsentSource, newConsentEvidence, loadAll]);

  /**
   * Upload a list.
   *
   * Answers before the work is done — the import is queued, not applied — so the button hands over
   * to the poll below rather than reporting success. Saying "imported" here would be a claim about
   * rows nothing has looked at yet.
   */
  const uploadImport = useCallback(async (): Promise<void> => {
    if (orgId === null || importFile === null) return;
    setError(null);
    setNotice(null);
    setUploading(true);
    setSkippedRows([]);
    setSkippedTruncated(false);
    try {
      const res = await api.createContactImport(orgId, importFile);
      setActiveImport(res.import);
      setImportFile(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setUploading(false);
    }
  }, [orgId, importFile]);

  /**
   * Mint an opt-in link.
   *
   * The phrase is the only part the operator writes, and it is worth writing carefully: it is the
   * sentence the customer sends, which means it is also the evidence of what they agreed to. The
   * server appends the reference code that identifies the link on the way back.
   */
  const mintOptinLink = useCallback(async (): Promise<void> => {
    if (orgId === null || linkChannelId === '') return;
    setError(null);
    setNotice(null);
    setMintingLink(true);
    try {
      const res = await api.createOptinLink(orgId, {
        channelAccountId: linkChannelId,
        name: linkName,
        purpose: linkPurpose,
        phrase: linkPhrase,
      });
      setOptinLinks((current) => [res.link, ...current]);
      setLinkName('');
      setNotice(
        `"${res.link.name}" is live. Anyone who opens it and sends the message is recorded as ` +
          `${res.link.purpose === 'marketing' ? 'opted in to marketing' : 'a service contact'}.`,
      );
    } catch (err) {
      setError(describeError(err));
    } finally {
      setMintingLink(false);
    }
  }, [orgId, linkChannelId, linkName, linkPurpose, linkPhrase]);

  const disableOptinLink = useCallback(
    async (linkId: string): Promise<void> => {
      if (orgId === null) return;
      setError(null);
      setNotice(null);
      try {
        const res = await api.disableOptinLink(orgId, linkId);
        setOptinLinks((current) => current.map((l) => (l.id === linkId ? res.link : l)));
        setNotice(
          `"${res.link.name}" is retired. Anyone who scans it from here on lands in the inbox as ` +
            'an ordinary message, with no opt-in recorded.',
        );
      } catch (err) {
        setError(describeError(err));
      }
    },
    [orgId],
  );

  /**
   * Follow a running import until it stops.
   *
   * Polled rather than pushed, and the contact list is reloaded only once the import is `done` —
   * refreshing it half way would show a list that grows while the operator reads it and a skipped
   * count that is not final, which invites acting on a report that has not finished being written.
   */
  useEffect(() => {
    if (orgId === null || activeImport === null) return;
    if (activeImport.status !== 'queued' && activeImport.status !== 'running') return;

    let cancelled = false;
    const timer = setTimeout(() => {
      void (async (): Promise<void> => {
        try {
          const res = await api.getContactImport(orgId, activeImport.id);
          if (cancelled) return;
          setActiveImport(res.import);
          setSkippedRows(res.skippedRows);
          setSkippedTruncated(res.skippedTruncated);
          if (res.import.status === 'done' || res.import.status === 'failed') {
            await loadAll(orgId);
          }
        } catch (err) {
          if (!cancelled) setError(describeError(err));
        }
      })();
    }, 1500);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [orgId, activeImport, loadAll]);

  const openContact = useCallback(
    async (contactId: string): Promise<void> => {
      if (orgId === null) return;
      if (openContactId === contactId) {
        setOpenContactId(null);
        return;
      }
      setError(null);
      setOpenContactId(contactId);
      setConsents([]);
      try {
        const res = await api.listContactConsents(orgId, contactId);
        setConsents(res.consents);
      } catch (err) {
        setError(describeError(err));
      }
    },
    [orgId, openContactId],
  );

  const recordConsent = useCallback(
    async (contactId: string, state: 'opted_in' | 'opted_out'): Promise<void> => {
      if (orgId === null) return;
      setError(null);
      try {
        const res = await api.recordContactConsent(orgId, contactId, {
          purpose: 'marketing',
          state,
          // Recorded by a member sitting at this screen, on the organization's word — which is
          // exactly what `attested` means, and why the evidence field cannot be blank.
          source: 'attested',
          evidence: consentEvidence.trim(),
        });
        setConsents((current) => [res.consent, ...current]);
        setConsentEvidence('');
        setNotice(state === 'opted_in' ? 'Opt-in recorded.' : 'Opt-out recorded.');
      } catch (err) {
        setError(describeError(err));
      }
    },
    [orgId, consentEvidence],
  );

  const addTag = useCallback(
    async (contactId: string): Promise<void> => {
      if (orgId === null || newTag.trim() === '') return;
      setError(null);
      try {
        await api.addContactTag(orgId, contactId, { tag: newTag.trim() });
        setNewTag('');
        await loadAll(orgId);
        setOpenContactId(contactId);
      } catch (err) {
        setError(describeError(err));
      }
    },
    [orgId, newTag, loadAll],
  );

  const removeTag = useCallback(
    async (contactId: string, tagId: string): Promise<void> => {
      if (orgId === null) return;
      setError(null);
      try {
        await api.removeContactTag(orgId, contactId, tagId);
        await loadAll(orgId);
        setOpenContactId(contactId);
      } catch (err) {
        setError(describeError(err));
      }
    },
    [orgId, loadAll],
  );

  const savePolicy = useCallback(async (): Promise<void> => {
    if (orgId === null) return;
    setError(null);
    setNotice(null);
    try {
      const res = await api.updateMessagingPolicy(orgId, {
        timezone: timezone.trim(),
        quietHoursStart: quietStart.trim(),
        quietHoursEnd: quietEnd.trim(),
      });
      setPolicy(res.policy);
      setNotice('Quiet hours saved.');
    } catch (err) {
      setError(describeError(err));
    }
  }, [orgId, timezone, quietStart, quietEnd]);

  const attest = useCallback(async (): Promise<void> => {
    if (orgId === null) return;
    setError(null);
    try {
      const res = await api.attestMessagingPolicy(orgId, { attestationText: ATTESTATION_TEXT });
      setPolicy(res.policy);
      setNotice(
        'Attestation signed. Marketing sends are now permitted, subject to per-contact consent.',
      );
    } catch (err) {
      setError(describeError(err));
    }
  }, [orgId]);

  const createSegment = useCallback(async (): Promise<void> => {
    if (orgId === null || segmentName.trim() === '' || ruleTag === '') return;
    setError(null);
    try {
      const definition: SegmentDefinition = {
        match: 'all',
        rules: [{ type: 'tag', op: 'has', tag: ruleTag }],
      };
      await api.createCommerceSegment(orgId, { name: segmentName.trim(), definition });
      setSegmentName('');
      setNotice('Segment saved. Preview it to see who it reaches today.');
      await loadAll(orgId);
    } catch (err) {
      setError(describeError(err));
    }
  }, [orgId, segmentName, ruleTag, loadAll]);

  const previewSegment = useCallback(
    async (segment: CommerceSegment): Promise<void> => {
      if (orgId === null) return;
      setError(null);
      try {
        const res = await api.previewCommerceSegment(orgId, {
          definition: segment.definition,
          sampleLimit: 5,
        });
        setPreview(res.preview);
        setPreviewedSegmentId(segment.id);
      } catch (err) {
        setError(describeError(err));
      }
    },
    [orgId],
  );

  const deleteSegment = useCallback(
    async (segmentId: string): Promise<void> => {
      if (orgId === null) return;
      setError(null);
      try {
        await api.deleteCommerceSegment(orgId, segmentId);
        if (previewedSegmentId === segmentId) setPreview(null);
        await loadAll(orgId);
      } catch (err) {
        setError(describeError(err));
      }
    },
    [orgId, previewedSegmentId, loadAll],
  );

  const suppress = useCallback(async (): Promise<void> => {
    if (orgId === null) return;
    setError(null);
    try {
      const digits = suppressNumber.replace(/[^\d]/g, '');
      await api.createSuppression(orgId, {
        platform: 'whatsapp_cloud',
        externalId: digits,
        reason: 'manual',
        detail: 'Blocked from the audience page',
      });
      setSuppressNumber('');
      await loadAll(orgId);
    } catch (err) {
      setError(describeError(err));
    }
  }, [orgId, suppressNumber, loadAll]);

  const unsuppress = useCallback(
    async (row: Suppression): Promise<void> => {
      if (orgId === null) return;
      setError(null);
      try {
        await api.deleteSuppression(orgId, row.platform, row.externalId);
        setNotice(
          'Block lifted. This did NOT record an opt-in — marketing still needs consent on file.',
        );
        await loadAll(orgId);
      } catch (err) {
        setError(describeError(err));
      }
    },
    [orgId, loadAll],
  );

  const isAdmin = role !== null && roleMeetsMinimum(role, 'admin');
  const isOwner = role !== null && roleMeetsMinimum(role, 'owner');

  return (
    <div className={styles.page}>
      <AppNav />
      <main className={styles.main}>
        <h1 className={styles.title}>Audience</h1>
        <p className={styles.subtitle}>
          Who your campaigns can reach, and the consent that decides it. Campaigns themselves live on{' '}
          <Link to="/commerce/campaigns">the campaigns page</Link>.
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

        {orgId !== null && (
          <>
            <section className={styles.card}>
              <h2 className={styles.cardTitle}>Sending policy</h2>
              {policy === null && (
                <p className={styles.muted}>
                  No policy yet — which means no marketing messages can be sent at all. Set quiet
                  hours, then sign the opt-in attestation.
                </p>
              )}
              <div className={styles.row}>
                <input
                  className={styles.input}
                  placeholder="IANA timezone, e.g. Europe/London"
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                />
                <input
                  className={styles.input}
                  placeholder="Quiet from (HH:MM)"
                  value={quietStart}
                  onChange={(e) => setQuietStart(e.target.value)}
                />
                <input
                  className={styles.input}
                  placeholder="until (HH:MM)"
                  value={quietEnd}
                  onChange={(e) => setQuietEnd(e.target.value)}
                />
                <button
                  type="button"
                  className={styles.primary}
                  disabled={!isAdmin || timezone.trim() === ''}
                  onClick={() => void savePolicy()}
                >
                  Save quiet hours
                </button>
              </div>
              {policy !== null && policy.attestedAt === null && (
                <>
                  <p className={styles.muted}>“{ATTESTATION_TEXT}”</p>
                  <button
                    type="button"
                    className={styles.primary}
                    disabled={!isOwner}
                    onClick={() => void attest()}
                  >
                    {isOwner ? 'Sign as owner' : 'Only the owner can sign this'}
                  </button>
                </>
              )}
              {policy !== null && policy.attestedAt !== null && (
                <p className={styles.muted}>
                  Opt-in attested on {new Date(policy.attestedAt).toLocaleDateString()}. Quiet hours{' '}
                  {policy.quietHoursStart}–{policy.quietHoursEnd} {policy.timezone}.
                </p>
              )}
            </section>

            <section className={styles.card}>
              <h2 className={styles.cardTitle}>Contacts</h2>
              <div className={styles.row}>
                <input
                  className={styles.input}
                  placeholder="Search by name or number"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <button type="button" className={styles.ghost} onClick={() => void searchContacts()}>
                  Search
                </button>
              </div>

              {isAdmin && (
                <div className={styles.subsection}>
                  <h3 className={styles.subTitle}>Add a contact</h3>
                  <div className={styles.row}>
                    <input
                      className={styles.input}
                      placeholder="+44 7700 900123"
                      value={newPhone}
                      onChange={(e) => setNewPhone(e.target.value)}
                    />
                    <input
                      className={styles.input}
                      placeholder="Name (optional)"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                    />
                    <input
                      className={styles.input}
                      placeholder="Tags, comma separated"
                      value={newTags}
                      onChange={(e) => setNewTags(e.target.value)}
                    />
                  </div>
                  <label className={styles.checkboxRow}>
                    <input
                      type="checkbox"
                      checked={newConsent}
                      onChange={(e) => setNewConsent(e.target.checked)}
                    />
                    <span>This person has given marketing opt-in</span>
                  </label>
                  {newConsent ? (
                    <div className={styles.row}>
                      <select
                        className={styles.input}
                        value={newConsentSource}
                        onChange={(e) => setNewConsentSource(toConsentSource(e.target.value))}
                      >
                        {SELECTABLE_CONSENT_SOURCES.map((source) => (
                          <option key={source.value} value={source.value}>
                            {source.label}
                          </option>
                        ))}
                      </select>
                      <input
                        className={styles.input}
                        placeholder="Where it came from — a form URL, ad id, or list name"
                        value={newConsentEvidence}
                        onChange={(e) => setNewConsentEvidence(e.target.value)}
                      />
                    </div>
                  ) : (
                    // Said here rather than discovered from a campaign that skipped them. Absence of
                    // consent refuses marketing; it does not quietly permit it.
                    <p className={styles.muted}>
                      Without an opt-in on file this contact can be tagged and segmented, but
                      marketing messages to them will be refused.
                    </p>
                  )}
                  <button
                    type="button"
                    className={styles.primary}
                    disabled={adding || newPhone.trim() === ''}
                    onClick={() => void addContact()}
                  >
                    {adding ? 'Adding…' : 'Add contact'}
                  </button>
                </div>
              )}

              {isAdmin && (
                <div className={styles.subsection}>
                  <h3 className={styles.subTitle}>Import a list</h3>
                  {/*
                    The columns are stated up front, and the consent ones are marked required.
                    This is where a business's real list arrives, and the difference between a list
                    that carries its provenance and one that does not is the whole of whether the
                    people on it can lawfully be messaged. A row without it is reported back, not
                    imported — better said here than discovered afterwards.
                  */}
                  <p className={styles.muted}>
                    CSV with a header row. Required: <code>phone</code>, <code>consent_purpose</code>{' '}
                    (service or marketing), <code>consent_state</code> (opted_in or opted_out),{' '}
                    <code>consent_source</code>, <code>consent_evidence</code>. Optional:{' '}
                    <code>name</code>, <code>tags</code> (separated by semicolons). Any other column
                    becomes an attribute segments can target. Rows with no consent on them are
                    reported back and not imported.
                  </p>
                  <div className={styles.row}>
                    <input
                      className={styles.input}
                      type="file"
                      accept=".csv,text/csv"
                      onChange={(e) => setImportFile(e.target.files?.[0] ?? null)}
                    />
                    <button
                      type="button"
                      className={styles.primary}
                      disabled={uploading || importFile === null}
                      onClick={() => void uploadImport()}
                    >
                      {uploading ? 'Uploading…' : 'Import'}
                    </button>
                  </div>

                  {activeImport !== null && (
                    <div className={styles.subsection}>
                      <p className={styles.muted}>
                        {activeImport.filename} —{' '}
                        {activeImport.status === 'queued' || activeImport.status === 'running'
                          ? `${activeImport.importedCount + activeImport.skippedCount} of ${activeImport.totalRows} rows read…`
                          : activeImport.status === 'failed'
                            ? `Import failed: ${activeImport.error ?? 'unknown reason'}`
                            : `Done. ${activeImport.importedCount} imported, ${activeImport.skippedCount} skipped.`}
                      </p>
                      {skippedRows.length > 0 && (
                        <ul className={styles.list}>
                          {skippedRows.map((skipped) => (
                            <li key={skipped.id} className={styles.listRow}>
                              {/* The row number and the number in its original form — the two
                                  things that let someone find the line in their spreadsheet. */}
                              <span>
                                Row {skipped.rowNumber}: {skipped.rawPhone || '(no number)'}
                              </span>
                              <span className={clsx(styles.tag, styles.tagError)}>
                                {skipped.detail ?? skipped.skipReason}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {skippedTruncated && (
                        <p className={styles.muted}>
                          Showing the first {skippedRows.length} skipped rows of{' '}
                          {activeImport.skippedCount}.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className={styles.subsection}>
                <h3 className={styles.subTitle}>Opt-in links</h3>
                {/*
                  Framed around what the link IS rather than how it works. The operator's decision is
                  what sentence to put in front of a customer; the token, the matching and the consent
                  row are ours. The one mechanical fact worth stating is that a customer has to send
                  the message — opening the chat and closing it records nothing — because that is what
                  makes the phrase evidence rather than a checkbox.
                */}
                <p className={styles.muted}>
                  A link that opens WhatsApp with a message already written. When the customer sends
                  it, their permission is recorded against their own number, in their own words.
                  Opening the chat is not enough — they have to send it. Put one behind a QR code on
                  a receipt, a menu, or a website button.
                </p>

                {isAdmin && (
                  <>
                    {channelAccounts.length === 0 ? (
                      <p className={styles.muted}>
                        Connect a WhatsApp number first — a link has to open a chat with something.
                      </p>
                    ) : (
                      <>
                        <div className={styles.row}>
                          {/* Shown whenever there is a choice to make. With one number it is
                              preselected and this still displays it, so what the link will point at
                              is never implicit. */}
                          <select
                            className={styles.select}
                            value={linkChannelId}
                            onChange={(e) => setLinkChannelId(e.target.value)}
                          >
                            <option value="">Which number…</option>
                            {channelAccounts.map((account) => (
                              <option key={account.id} value={account.id}>
                                {account.displayName}
                              </option>
                            ))}
                          </select>
                          <input
                            className={styles.input}
                            placeholder="Name it — Receipt QR, Website footer"
                            value={linkName}
                            onChange={(e) => setLinkName(e.target.value)}
                          />
                          <select
                            className={styles.select}
                            value={linkPurpose}
                            onChange={(e) => setLinkPurpose(e.target.value as ConsentPurpose)}
                          >
                            <option value="marketing">Marketing — campaigns and offers</option>
                            <option value="service">Service — support replies only</option>
                          </select>
                        </div>
                        <div className={styles.row}>
                          <input
                            className={styles.input}
                            placeholder="The message they will send"
                            value={linkPhrase}
                            onChange={(e) => setLinkPhrase(e.target.value)}
                          />
                          <button
                            type="button"
                            className={styles.primary}
                            disabled={
                              mintingLink ||
                              linkChannelId === '' ||
                              linkName.trim() === '' ||
                              linkPhrase.trim() === ''
                            }
                            onClick={() => void mintOptinLink()}
                          >
                            {mintingLink ? 'Creating…' : 'Create link'}
                          </button>
                        </div>
                        {/* Said next to the field that decides it. A marketing link is the only one
                            of the two that changes who a campaign can reach, so the wording of its
                            sentence is the thing a complaint will be judged against. */}
                        {linkPurpose === 'marketing' && (
                          <p className={styles.muted}>
                            Write it as an agreement — &ldquo;Yes, send me offers&rdquo; — not a
                            greeting. This sentence is what proves they asked to hear from you.
                          </p>
                        )}
                      </>
                    )}
                  </>
                )}

                {optinLinks.length === 0 ? (
                  <p className={styles.muted}>No opt-in links yet.</p>
                ) : (
                  <ul className={styles.list}>
                    {optinLinks.map((link) => (
                      <li key={link.id} className={styles.listRow}>
                        <span>
                          <strong>{link.name}</strong>
                          {' — '}
                          {link.optInCount} opt-in{link.optInCount === 1 ? '' : 's'}
                          {link.status === 'disabled' && ' (retired)'}
                          <br />
                          <code>{link.prefillText}</code>
                        </span>
                        <span className={styles.row}>
                          <span className={clsx(styles.tag, link.purpose === 'marketing' && styles.tagWarn)}>
                            {link.purpose}
                          </span>
                          {/* Copying the URL is the whole point of the row — it is what gets pasted
                              into a QR generator or a website button. */}
                          <button
                            type="button"
                            className={styles.ghost}
                            onClick={() => {
                              void navigator.clipboard.writeText(link.url);
                              setCopiedLinkId(link.id);
                            }}
                          >
                            {copiedLinkId === link.id ? 'Copied' : 'Copy link'}
                          </button>
                          {isAdmin && link.status === 'active' && (
                            <button
                              type="button"
                              className={styles.ghost}
                              onClick={() => void disableOptinLink(link.id)}
                            >
                              Retire
                            </button>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {contacts.length === 0 ? (
                <p className={styles.muted}>
                  No contacts yet. Add one above, or wait for someone to message a connected number.
                </p>
              ) : (
                <ul className={styles.list}>
                  {contacts.map((contact) => (
                    <li key={contact.id}>
                      <button
                        type="button"
                        className={clsx(
                          styles.threadButton,
                          contact.id === openContactId && styles.threadButtonActive,
                        )}
                        onClick={() => void openContact(contact.id)}
                      >
                        <strong>
                          {contact.displayName ?? contact.phoneE164 ?? contact.externalId}
                        </strong>{' '}
                        {contact.tags.map((tagName) => (
                          <span key={tagName} className={styles.tag}>
                            {tagName}
                          </span>
                        ))}
                      </button>
                      {contact.id === openContactId && (
                        <div className={styles.list}>
                          <div className={styles.row}>
                            <input
                              className={styles.input}
                              placeholder="Add a tag"
                              value={newTag}
                              onChange={(e) => setNewTag(e.target.value)}
                            />
                            <button
                              type="button"
                              className={styles.ghost}
                              disabled={newTag.trim() === ''}
                              onClick={() => void addTag(contact.id)}
                            >
                              Tag
                            </button>
                            {contact.tags.map((tagName) => {
                              // The contact carries tag NAMES; removal is by id, resolved from the
                              // org's tag list loaded alongside.
                              const tagRow = tags.find((t) => t.name === tagName);
                              if (tagRow === undefined) return null;
                              return (
                                <button
                                  key={tagName}
                                  type="button"
                                  className={styles.ghost}
                                  onClick={() => void removeTag(contact.id, tagRow.id)}
                                >
                                  Remove “{tagName}”
                                </button>
                              );
                            })}
                          </div>
                          {consents.length === 0 ? (
                            <p className={styles.muted}>
                              No consent on file. Without a recorded marketing opt-in, campaigns skip
                              this person.
                            </p>
                          ) : (
                            <ul className={styles.list}>
                              {consents.map((consent) => (
                                <li key={consent.id} className={styles.muted}>
                                  {consent.purpose}: {consent.state} · via {consent.source} ·{' '}
                                  {new Date(consent.recordedAt).toLocaleString()} · evidence:{' '}
                                  {consent.evidence}
                                </li>
                              ))}
                            </ul>
                          )}
                          {isAdmin && (
                            <div className={styles.row}>
                              <input
                                className={styles.input}
                                placeholder="Evidence (form URL, file name…) — required"
                                value={consentEvidence}
                                onChange={(e) => setConsentEvidence(e.target.value)}
                              />
                              <button
                                type="button"
                                className={styles.ghost}
                                disabled={consentEvidence.trim() === ''}
                                onClick={() => void recordConsent(contact.id, 'opted_in')}
                              >
                                Record opt-in
                              </button>
                              <button
                                type="button"
                                className={styles.ghost}
                                disabled={consentEvidence.trim() === ''}
                                onClick={() => void recordConsent(contact.id, 'opted_out')}
                              >
                                Record opt-out
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className={styles.card}>
              <h2 className={styles.cardTitle}>Segments</h2>
              {segments.length > 0 && (
                <ul className={styles.list}>
                  {segments.map((segment) => (
                    <li key={segment.id} className={styles.listRow}>
                      <span>
                        {segment.name}
                        {previewedSegmentId === segment.id && preview !== null && (
                          <span className={styles.muted}>
                            {' '}
                            — {preview.total} selected, {preview.sendable} reachable
                            {preview.orgBlockedReason !== null &&
                              ' (all blocked until the sending policy above is completed)'}
                            {AUDIENCE_BLOCK_REASONS.filter((r) => preview.blocked[r] > 0)
                              .map((r) => ` · ${preview.blocked[r]} ${BLOCK_REASON_LABELS[r]}`)
                              .join('')}
                          </span>
                        )}
                      </span>
                      <span>
                        <button
                          type="button"
                          className={styles.ghost}
                          onClick={() => void previewSegment(segment)}
                        >
                          Preview
                        </button>
                        {isAdmin && (
                          <button
                            type="button"
                            className={styles.ghost}
                            onClick={() => void deleteSegment(segment.id)}
                          >
                            Delete
                          </button>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {isAdmin && (
                <div className={styles.row}>
                  <input
                    className={styles.input}
                    placeholder="Segment name"
                    value={segmentName}
                    onChange={(e) => setSegmentName(e.target.value)}
                  />
                  <select
                    className={styles.select}
                    value={ruleTag}
                    onChange={(e) => setRuleTag(e.target.value)}
                  >
                    <option value="">Everyone tagged…</option>
                    {tags.map((tag) => (
                      <option key={tag.id} value={tag.name}>
                        {tag.name} ({tag.contactCount})
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className={styles.primary}
                    disabled={segmentName.trim() === '' || ruleTag === ''}
                    onClick={() => void createSegment()}
                  >
                    Save segment
                  </button>
                </div>
              )}
              <p className={styles.muted}>
                A segment is a rule, not a list: who it reaches is decided at the moment a campaign
                dispatches, against that moment&apos;s consent records.
              </p>
            </section>

            <section className={styles.card}>
              <h2 className={styles.cardTitle}>Suppression list</h2>
              <p className={styles.muted}>
                Addresses this organization may not message at all, whatever any consent record says.
              </p>
              {suppressions.length > 0 && (
                <ul className={styles.list}>
                  {suppressions.map((row) => (
                    <li key={row.id} className={styles.listRow}>
                      <span>
                        +{row.externalId} <span className={styles.tag}>{row.reason}</span>
                        {row.detail !== null && (
                          <span className={styles.muted}> — {row.detail}</span>
                        )}
                      </span>
                      {isAdmin && (
                        <button
                          type="button"
                          className={styles.ghost}
                          onClick={() => void unsuppress(row)}
                        >
                          Lift block
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {isAdmin && (
                <div className={styles.row}>
                  <input
                    className={styles.input}
                    placeholder="Phone number to block, e.g. +15550100200"
                    value={suppressNumber}
                    onChange={(e) => setSuppressNumber(e.target.value)}
                  />
                  <button
                    type="button"
                    className={styles.ghost}
                    disabled={suppressNumber.replace(/[^\d]/g, '').length < 7}
                    onClick={() => void suppress()}
                  >
                    Block
                  </button>
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
