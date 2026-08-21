import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { Link } from 'react-router';
import type {
  ChannelAccount,
  CommerceConversationSummary,
  CommerceMessage,
  EmbeddedSignupConfig,
  MessageTemplate,
  OrgMembership,
} from '@stewra/shared-types';
import { roleMeetsMinimum } from '@stewra/shared-types';
import { AppNav } from '../../components/AppNav/AppNav';
import { api, ApiError } from '../../services/api';
import { launchEmbeddedSignup } from './metaEmbeddedSignup';
import { COMPANY_NAME, PRODUCT_NAME } from '../legal/company';
import styles from './CommercePage.module.css';

function describeError(err: unknown): string {
  // Unlike the other pages, a plain Error is shown as-is: the Embedded Signup launcher throws ones
  // that say exactly what went wrong ("could not load Meta's SDK"), and "Something went wrong"
  // would replace a usable diagnosis with a shrug.
  return err instanceof Error ? err.message : 'Something went wrong';
}

/**
 * True when the server refused because of the number's registration PIN — either it needs one it
 * was not given, or Meta rejected the one it was.
 *
 * Both refusals want the same next step, and it is not simply "retry": the authorization code was
 * already spent on the token exchange before either could be discovered, and Meta's codes are
 * single-use. So the client has to walk the dialog again with the PIN in hand.
 */
function isPinRefusal(err: unknown): boolean {
  return err instanceof ApiError && err.details.some((d) => d.field === 'pin');
}

/**
 * How long a connected account's Meta access has left, in words. Null when there is nothing to say.
 *
 * A different deadline from the 24-hour service window below, and a much less obvious one. Meta's
 * Embedded Signup configuration that grants the full WhatsApp permission set issues a credential
 * that dies after 60 days, and the only cure is the business owner approving Meta's dialog again.
 * A business that is not told will find out when its customers stop getting replies.
 *
 * Nothing is said until the last two weeks: a deadline eight weeks out is noise, and noise is what
 * teaches people to ignore the notice that matters. Past the deadline this stays null on purpose —
 * the account is `error` by then and carries the server's own explanation, which is more specific
 * than anything this could add.
 */
function accessRemaining(expiresAt: string | null): { label: string; urgent: boolean } | null {
  if (expiresAt === null) return null;
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return null;
  const days = Math.ceil(ms / 86_400_000);
  if (days > 14) return null;
  return { label: days === 1 ? 'access expires tomorrow' : `access expires in ${days} days`, urgent: days <= 3 };
}

/** How long is left on the 24-hour window, in words. Null when it has closed or never opened. */
function windowRemaining(expiresAt: string | null): string | null {
  if (expiresAt === null) return null;
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return null;
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return hours > 0 ? `${hours}h ${minutes}m left` : `${minutes}m left`;
}

/**
 * The commerce plane's verification surface: which organizations you belong to, which WhatsApp
 * numbers each has connected, and the shared inbox those numbers feed.
 *
 * Deliberately the FALLBACK surface, not the headline — the product is meant to be driven by texting
 * Stewra. This exists for what a chat thread is bad at: seeing every thread at once, and connecting
 * a channel, which needs a browser because Meta's Embedded Signup is a browser dialog.
 */
export default function CommercePage(): React.JSX.Element {
  const [memberships, setMemberships] = useState<ReadonlyArray<OrgMembership>>([]);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  const [orgName, setOrgName] = useState('');
  const [companyName, setCompanyName] = useState('');

  const [accounts, setAccounts] = useState<ReadonlyArray<ChannelAccount>>([]);
  const [signup, setSignup] = useState<EmbeddedSignupConfig | null>(null);
  const [connectPin, setConnectPin] = useState('');
  const [pinRequired, setPinRequired] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const [conversations, setConversations] = useState<ReadonlyArray<CommerceConversationSummary>>([]);
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ReadonlyArray<CommerceMessage>>([]);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);

  const [templates, setTemplates] = useState<ReadonlyArray<MessageTemplate>>([]);
  const [templateId, setTemplateId] = useState('');
  const [templateVars, setTemplateVars] = useState<ReadonlyArray<string>>([]);
  const [sendingTemplate, setSendingTemplate] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selectedMembership = memberships.find((m) => m.org.id === orgId) ?? null;
  const role = selectedMembership?.role ?? null;
  const openThread = conversations.find((c) => c.id === openThreadId) ?? null;
  const replyWindow = openThread === null ? null : windowRemaining(openThread.serviceWindowExpiresAt);

  // Only templates that can actually go into THIS thread: approved, and belonging to the same
  // WhatsApp number the conversation runs on — the server refuses a mismatch, so offering one
  // here would only manufacture an error.
  const sendableTemplates =
    openThread === null
      ? []
      : templates.filter(
          (t) => t.status === 'approved' && t.channelAccountId === openThread.channelAccountId,
        );
  const selectedThreadTemplate = sendableTemplates.find((t) => t.id === templateId) ?? null;

  const loadOrgs = useCallback(async (): Promise<void> => {
    try {
      const res = await api.listOrgs();
      setMemberships(res.memberships);
      setActiveOrgId(res.activeOrgId);
      // Select the org the conversational surface is already pointed at, so the two agree. Falls back
      // to the first membership only for VIEWING — the stored active org is never guessed on the user's
      // behalf, because that is what decides who a campaign goes to.
      setOrgId((current) => current ?? res.activeOrgId ?? res.memberships[0]?.org.id ?? null);
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void loadOrgs();
  }, [loadOrgs]);

  const loadOrgData = useCallback(async (id: string): Promise<void> => {
    try {
      const [channelsRes, conversationsRes, templatesRes] = await Promise.all([
        api.listChannelAccounts(id),
        api.listCommerceConversations(id, { limit: 30 }),
        api.listMessageTemplates(id),
      ]);
      setAccounts(channelsRes.accounts);
      setSignup(channelsRes.signup);
      setConversations(conversationsRes.conversations);
      setTemplates(templatesRes.templates);
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    if (orgId === null) return;
    setOpenThreadId(null);
    setMessages([]);
    void loadOrgData(orgId);
  }, [orgId, loadOrgData]);

  const createOrg = useCallback(async (): Promise<void> => {
    setError(null);
    setNotice(null);
    try {
      const res = await api.createOrg({ name: orgName.trim() });
      setOrgName('');
      setOrgId(res.org.id);
      setNotice(`Created ${res.org.name}. You are its owner.`);
      await loadOrgs();
    } catch (err) {
      setError(describeError(err));
    }
  }, [orgName, loadOrgs]);

  /**
   * An individual account becomes a business one. This is the only way a personal org grows a team:
   * invites are refused until the owner takes this step, by name, on purpose.
   */
  const convertOrg = useCallback(async (): Promise<void> => {
    if (orgId === null) return;
    setError(null);
    setNotice(null);
    try {
      const res = await api.convertOrg(orgId, { companyName: companyName.trim() });
      setCompanyName('');
      setNotice(`${res.org.name} is now a business organization. You can invite your team.`);
      await loadOrgs();
    } catch (err) {
      setError(describeError(err));
    }
  }, [orgId, companyName, loadOrgs]);

  const makeActive = useCallback(async (): Promise<void> => {
    if (orgId === null) return;
    setError(null);
    try {
      const res = await api.setActiveOrg({ orgId });
      setActiveOrgId(res.activeOrgId);
      setNotice('Texting Stewra now acts on this organization.');
    } catch (err) {
      setError(describeError(err));
    }
  }, [orgId]);

  const connect = useCallback(async (): Promise<void> => {
    if (orgId === null || signup === null) return;
    setError(null);
    setNotice(null);
    setConnecting(true);
    try {
      const code = await launchEmbeddedSignup(signup);
      if (code === null) {
        setNotice('Connection cancelled — nothing was changed.');
        return;
      }
      // The PIN is only sent when one was typed. An empty string is not "no PIN" — it is a PIN of
      // zero digits, and Meta counts a rejected attempt against a lockout that lasts hours.
      const trimmedPin = connectPin.trim();
      const res = await api.connectWhatsappAccount(orgId, {
        code,
        ...(trimmedPin === '' ? {} : { pin: trimmedPin }),
      });
      setConnectPin('');
      setPinRequired(false);
      setNotice(`Connected ${res.account.displayName}.`);
      await loadOrgData(orgId);
    } catch (err) {
      setError(describeError(err));
      if (isPinRefusal(err)) setPinRequired(true);
      // The channel row may exist in an error state even when this failed — a rejected PIN keeps the
      // connection and labels it — so the list is refreshed either way.
      await loadOrgData(orgId);
    } finally {
      setConnecting(false);
    }
  }, [orgId, signup, connectPin, loadOrgData]);

  const disconnect = useCallback(
    async (accountId: string): Promise<void> => {
      if (orgId === null) return;
      setError(null);
      try {
        await api.disconnectChannelAccount(orgId, accountId);
        setNotice('Channel disconnected. Its stored credential was deleted.');
        await loadOrgData(orgId);
      } catch (err) {
        setError(describeError(err));
      }
    },
    [orgId, loadOrgData],
  );

  const openConversation = useCallback(
    async (conversationId: string): Promise<void> => {
      if (orgId === null) return;
      setError(null);
      setOpenThreadId(conversationId);
      try {
        const res = await api.listCommerceMessages(orgId, conversationId, { limit: 50 });
        setMessages(res.messages);
      } catch (err) {
        setError(describeError(err));
      }
    },
    [orgId],
  );

  // Keep the variable inputs in lockstep with the chosen template's declared count.
  useEffect(() => {
    const count = selectedThreadTemplate?.variableCount ?? 0;
    setTemplateVars((current) => Array.from({ length: count }, (_, i) => current[i] ?? ''));
  }, [selectedThreadTemplate?.variableCount]);

  const sendTemplateMessage = useCallback(async (): Promise<void> => {
    if (orgId === null || openThreadId === null || templateId === '') return;
    setError(null);
    setSendingTemplate(true);
    try {
      const res = await api.sendConversationTemplate(orgId, openThreadId, {
        templateId,
        variables: templateVars,
      });
      setMessages((current) => [...current, res.message]);
      setTemplateId('');
      setTemplateVars([]);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSendingTemplate(false);
    }
  }, [orgId, openThreadId, templateId, templateVars]);

  const sendReply = useCallback(async (): Promise<void> => {
    if (orgId === null || openThreadId === null) return;
    setError(null);
    setSending(true);
    try {
      const res = await api.sendCommerceMessage(orgId, openThreadId, { body: reply.trim() });
      setMessages((current) => [...current, res.message]);
      setReply('');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSending(false);
    }
  }, [orgId, openThreadId, reply]);

  return (
    <div className={styles.page}>
      <AppNav />
      <main className={styles.main}>
        <h1 className={styles.title}>Commerce</h1>
        <p className={styles.subtitle}>
          Your businesses, the numbers they message from, and everything customers have said. Manage
          contacts and consent on <Link to="/commerce/audience">Audience</Link>; templates,
          broadcasts and costs on <Link to="/commerce/campaigns">Campaigns</Link>; members and
          invites on <Link to="/commerce/team">Team</Link>; your plan, card and invoices on{' '}
          <Link to="/commerce/billing">Billing</Link>.
        </p>

        {error !== null && <div className={styles.error}>{error}</div>}
        {notice !== null && <div className={styles.notice}>{notice}</div>}

        <section className={styles.card}>
          <h2 className={styles.cardTitle}>Organizations</h2>
          {memberships.length === 0 ? (
            <p className={styles.muted}>You do not belong to an organization yet.</p>
          ) : (
            <div className={styles.row}>
              <select
                className={styles.select}
                value={orgId ?? ''}
                onChange={(e) => setOrgId(e.target.value)}
              >
                {memberships.map((m) => (
                  <option key={m.org.id} value={m.org.id}>
                    {m.org.name} · {m.org.kind === 'individual' ? 'personal' : 'business'} · {m.role}
                  </option>
                ))}
              </select>
              {orgId !== null && orgId !== activeOrgId && (
                <button type="button" className={styles.ghost} onClick={() => void makeActive()}>
                  Use this one when I text Stewra
                </button>
              )}
              {orgId !== null && orgId === activeOrgId && (
                <span className={styles.tag}>Texting Stewra acts on this one</span>
              )}
            </div>
          )}

          {selectedMembership !== null &&
            selectedMembership.org.kind === 'individual' &&
            selectedMembership.role === 'owner' && (
              <div className={clsx(styles.row, styles.list)} data-testid="org-convert">
                <span className={styles.muted}>
                  This is your personal account. To invite a team, convert it to a business
                  organization under the company&apos;s name.
                </span>
                <input
                  className={styles.input}
                  placeholder="Company name"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  data-testid="org-convert-name"
                />
                <button
                  type="button"
                  className={styles.ghost}
                  disabled={companyName.trim() === ''}
                  onClick={() => void convertOrg()}
                  data-testid="org-convert-submit"
                >
                  Convert to a business organization
                </button>
              </div>
            )}

          <div className={clsx(styles.row, styles.list)}>
            <input
              className={styles.input}
              placeholder="New organization name"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
            />
            <button
              type="button"
              className={styles.primary}
              disabled={orgName.trim() === ''}
              onClick={() => void createOrg()}
            >
              Create
            </button>
          </div>
        </section>

        {orgId !== null && (
          <section className={styles.card}>
            <h2 className={styles.cardTitle}>Connected numbers</h2>
            {accounts.length === 0 && (
              <p className={styles.muted}>
                No WhatsApp number connected yet. Customers cannot reach this business through Stewra
                until one is.
              </p>
            )}
            <ul className={styles.list}>
              {accounts.map((account) => {
                const access = accessRemaining(account.credentialExpiresAt);
                return (
                <li key={account.id} className={styles.listRow}>
                  <span>
                    {account.displayName}{' '}
                    <span className={clsx(styles.tag, account.status !== 'active' && styles.tagError)}>
                      {account.status}
                    </span>
                    {access !== null && (
                      <>
                        {' '}
                        <span className={clsx(styles.tag, access.urgent && styles.tagWarn)}>
                          {access.label}
                        </span>
                      </>
                    )}
                    {account.errorDetail !== null && (
                      <span className={styles.muted}> — {account.errorDetail}</span>
                    )}
                    {access !== null && (
                      // Said in full rather than left as a tag: "expires in 9 days" does not tell
                      // anybody what to do about it, and the action is not obvious — Meta requires
                      // the business owner, not us, to approve the dialog again.
                      <span className={styles.muted}>
                        {' '}
                        — connect this account again to renew it. Meta only lets the business owner
                        do that, and messages stop sending the moment it lapses.
                      </span>
                    )}
                  </span>
                  {role !== null && roleMeetsMinimum(role, 'admin') && (
                    <button
                      type="button"
                      className={styles.ghost}
                      onClick={() => void disconnect(account.id)}
                    >
                      Disconnect
                    </button>
                  )}
                </li>
                );
              })}
            </ul>

            {signup === null ? (
              // Not a placeholder button that fails on click: this deploy has no commerce Meta app,
              // and saying so beats opening a dialog on nothing.
              <p className={styles.muted}>
                Connecting a WhatsApp Business Account is not enabled on this deployment.
              </p>
            ) : (
              <>
                <p className={styles.muted}>
                  Sign in with the Meta account that already owns your WhatsApp Business Account and
                  grant Stewra access. Nothing is created for you, and this browser never handles a
                  credential — Meta&apos;s dialog returns a one-time code and the server does the
                  rest.
                </p>
                {/* Said before the dialog opens, not after. Meta shows the app name next to the
                    verified business portfolio behind it, and a client who has only ever heard the
                    product name has no way to recognise the legal entity — an unexpected name on a
                    permissions screen is exactly when someone abandons a connect flow. */}
                <p className={styles.muted}>
                  Meta will ask you to grant access to <strong>{PRODUCT_NAME}</strong>, operated by{' '}
                  <strong>{COMPANY_NAME}</strong>. That is us — the same company named in our{' '}
                  <Link to="/privacy">privacy policy</Link> and <Link to="/terms">terms</Link>.
                </p>
                <div className={styles.row}>
                  {pinRequired && (
                    <input
                      className={styles.input}
                      placeholder="Six-digit PIN"
                      inputMode="numeric"
                      maxLength={6}
                      value={connectPin}
                      onChange={(e) => setConnectPin(e.target.value)}
                    />
                  )}
                  <button
                    type="button"
                    className={styles.primary}
                    disabled={
                      connecting ||
                      (pinRequired && connectPin.trim().length !== 6) ||
                      role === null ||
                      !roleMeetsMinimum(role, 'marketer')
                    }
                    onClick={() => void connect()}
                  >
                    {connecting
                      ? 'Connecting…'
                      : pinRequired
                        ? 'Connect again with this PIN'
                        : 'Connect WhatsApp Business Account'}
                  </button>
                </div>
                {pinRequired && (
                  <p className={styles.muted}>
                    That number still has to be registered for sending, which needs its six-digit
                    two-step verification PIN — find it in WhatsApp Manager under Two-step
                    verification. Meta&apos;s authorization is single-use, so connecting again
                    reopens the dialog; approve the same account and the PIN goes with it.
                  </p>
                )}
                <p className={styles.muted}>
                  Meta app {signup.appId} · flow {signup.configId} · Graph {signup.graphVersion}
                </p>
              </>
            )}
          </section>
        )}

        {orgId !== null && (
          <section className={styles.card}>
            <h2 className={styles.cardTitle}>Inbox</h2>
            {conversations.length === 0 ? (
              <p className={styles.muted}>No conversations yet.</p>
            ) : (
              <div className={styles.inbox}>
                <ul className={styles.list}>
                  {conversations.map((conversation) => (
                    <li key={conversation.id}>
                      <button
                        type="button"
                        className={clsx(
                          styles.threadButton,
                          conversation.id === openThreadId && styles.threadButtonActive,
                        )}
                        onClick={() => void openConversation(conversation.id)}
                      >
                        <strong>
                          {conversation.contactDisplayName ??
                            conversation.contactPhoneE164 ??
                            'Unknown contact'}
                        </strong>
                        <br />
                        <span className={styles.muted}>{conversation.lastMessagePreview}</span>
                      </button>
                    </li>
                  ))}
                </ul>

                <div>
                  {openThreadId === null ? (
                    <p className={styles.muted}>Pick a conversation.</p>
                  ) : (
                    <>
                      <div className={styles.thread}>
                        {messages.map((message) => (
                          <div
                            key={message.id}
                            className={clsx(
                              styles.bubble,
                              message.direction === 'inbound' && styles.inbound,
                              message.direction === 'outbound' &&
                                (message.status === 'failed' ? styles.failed : styles.outbound),
                            )}
                          >
                            {message.body}
                            {message.status === 'failed' && (
                              <div className={styles.muted}>
                                Not delivered: {message.failureReason ?? 'unknown reason'}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>

                      {replyWindow === null ? (
                        // Meta accepts a free-form send outside the window and then never delivers it,
                        // so the honest thing is to refuse here rather than show a sent message that
                        // nobody received.
                        <p className={styles.muted}>
                          The 24-hour reply window has closed. Only an approved template message can
                          reach this customer now
                          {sendableTemplates.length === 0
                            ? ' — and this number has none approved yet. Create one on Campaigns.'
                            : ' — pick one below.'}
                        </p>
                      ) : (
                        <div className={styles.row}>
                          <input
                            className={styles.input}
                            placeholder={`Reply — ${replyWindow}`}
                            value={reply}
                            onChange={(e) => setReply(e.target.value)}
                          />
                          <button
                            type="button"
                            className={styles.primary}
                            disabled={
                              sending ||
                              reply.trim() === '' ||
                              role === null ||
                              !roleMeetsMinimum(role, 'agent')
                            }
                            onClick={() => void sendReply()}
                          >
                            {sending ? 'Sending…' : 'Send'}
                          </button>
                        </div>
                      )}

                      {sendableTemplates.length > 0 && (
                        <>
                          <div className={styles.row}>
                            <select
                              className={styles.select}
                              value={templateId}
                              onChange={(e) => setTemplateId(e.target.value)}
                            >
                              <option value="">Send a template…</option>
                              {sendableTemplates.map((template) => (
                                <option key={template.id} value={template.id}>
                                  {template.name} ({template.language})
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              className={styles.primary}
                              disabled={
                                sendingTemplate ||
                                templateId === '' ||
                                templateVars.some((v) => v.trim() === '') ||
                                role === null ||
                                !roleMeetsMinimum(role, 'agent')
                              }
                              onClick={() => void sendTemplateMessage()}
                            >
                              {sendingTemplate ? 'Sending…' : 'Send template'}
                            </button>
                          </div>
                          {selectedThreadTemplate !== null &&
                            selectedThreadTemplate.variableCount > 0 && (
                              <div className={styles.row}>
                                {templateVars.map((value, index) => (
                                  <input
                                    // Positional by definition: these inputs ARE {{1}}..{{n}}, so the
                                    // index is the identity, not a stand-in for one.
                                    key={index}
                                    className={styles.input}
                                    placeholder={`Value for {{${index + 1}}}`}
                                    value={value}
                                    onChange={(e) =>
                                      setTemplateVars((current) =>
                                        current.map((v, i) => (i === index ? e.target.value : v)),
                                      )
                                    }
                                  />
                                ))}
                              </div>
                            )}
                          {selectedThreadTemplate !== null && (
                            <p className={styles.muted}>
                              {selectedThreadTemplate.category === 'utility' ||
                              selectedThreadTemplate.category === 'authentication'
                                ? 'Transactional template — needs no marketing consent.'
                                : 'Marketing template — this contact must have marketing consent on file.'}
                            </p>
                          )}
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
