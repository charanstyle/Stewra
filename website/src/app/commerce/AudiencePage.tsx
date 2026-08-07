import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { Link } from 'react-router';
import type {
  AudiencePreview,
  CommerceContactWithTags,
  CommerceSegment,
  CommerceTag,
  ContactConsent,
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
      const [policyRes, contactsRes, tagsRes, segmentsRes, suppressionsRes] = await Promise.all([
        api.getMessagingPolicy(id),
        api.listCommerceContacts(id, { limit: 50 }),
        api.listCommerceTags(id),
        api.listCommerceSegments(id),
        api.listSuppressions(id, { limit: 50 }),
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
              {contacts.length === 0 ? (
                <p className={styles.muted}>
                  No contacts yet. People appear here when they message a connected number.
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
