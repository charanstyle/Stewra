import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { OrgInvite, OrgMember, OrgRole } from '@stewra/shared-types';
import { ORG_ROLES, roleMeetsMinimum } from '@stewra/shared-types';
import { AppNav } from '../../components/AppNav/AppNav';
import { api } from '../../services/api';
import { useCommerceOrg } from './useCommerceOrg';
import styles from './CommercePage.module.css';

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}

/** Narrow a `<select>` value without asserting: an unknown string falls back to the safest role. */
function toRole(value: string): OrgRole {
  return ORG_ROLES.find((r) => r === value) ?? 'viewer';
}

/**
 * The org's people: who is in, at what role, and who has been invited but not yet joined.
 *
 * The permission story this page renders is the server's, not its own: `admin` manages membership,
 * only an `owner` may grant or revoke the owner role, and the last owner can never be demoted or
 * removed. Controls the caller's role cannot use are hidden or disabled here so a member learns what
 * they can do by looking, not by collecting 403s — but the enforcement stays server-side.
 */
export default function TeamPage(): React.JSX.Element {
  const { memberships, orgId, setOrgId, role, loadError } = useCommerceOrg();

  const [members, setMembers] = useState<ReadonlyArray<OrgMember>>([]);
  const [invites, setInvites] = useState<ReadonlyArray<OrgInvite>>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<OrgRole>('agent');
  const [inviting, setInviting] = useState(false);

  const isAdmin = role !== null && roleMeetsMinimum(role, 'admin');
  const isOwner = role !== null && roleMeetsMinimum(role, 'owner');

  const load = useCallback(async (id: string): Promise<void> => {
    const res = await api.listOrgMembers(id);
    setMembers(res.members);
    setInvites(res.invites);
  }, []);

  useEffect(() => {
    if (orgId === null) return;
    setError(null);
    setNotice(null);
    load(orgId).catch((err: unknown) => setError(describeError(err)));
  }, [orgId, load]);

  const sendInvite = useCallback(async (): Promise<void> => {
    if (orgId === null || inviteEmail.trim() === '') return;
    setInviting(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.createOrgInvite(orgId, { email: inviteEmail.trim(), role: inviteRole });
      setNotice(
        `Invite emailed to ${res.invite.email}. It grants ${res.invite.role} and expires ` +
          `${new Date(res.invite.expiresAt).toLocaleDateString()}.`,
      );
      setInviteEmail('');
      await load(orgId);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setInviting(false);
    }
  }, [orgId, inviteEmail, inviteRole, load]);

  const revokeInvite = useCallback(
    async (inviteId: string): Promise<void> => {
      if (orgId === null) return;
      setError(null);
      setNotice(null);
      try {
        await api.revokeOrgInvite(orgId, inviteId);
        await load(orgId);
      } catch (err) {
        setError(describeError(err));
      }
    },
    [orgId, load],
  );

  // No optimistic state anywhere on this page: the role select renders `member.role` straight from
  // the last successful load, so a failed PATCH simply leaves the old truth on screen next to the
  // error banner — there is nothing to roll back.
  const changeRole = useCallback(
    async (memberId: string, nextRole: OrgRole): Promise<void> => {
      if (orgId === null) return;
      setError(null);
      setNotice(null);
      try {
        await api.updateOrgMember(orgId, memberId, { role: nextRole });
        await load(orgId);
      } catch (err) {
        setError(describeError(err));
      }
    },
    [orgId, load],
  );

  const removeMember = useCallback(
    async (member: OrgMember): Promise<void> => {
      if (orgId === null) return;
      if (!window.confirm(`Remove ${member.displayName} from this organization?`)) return;
      setError(null);
      setNotice(null);
      try {
        await api.removeOrgMember(orgId, member.id);
        await load(orgId);
      } catch (err) {
        setError(describeError(err));
      }
    },
    [orgId, load],
  );

  /** The roles this caller may hand out: everything below owner for an admin, all of them for an owner. */
  const assignableRoles = ORG_ROLES.filter((r) => r !== 'owner' || isOwner);

  return (
    <div className={styles.page}>
      <AppNav />
      <main className={styles.main}>
        <h1 className={styles.title}>Team</h1>
        <p className={styles.subtitle}>
          Who works this organization&apos;s inbox and campaigns. Conversations live on{' '}
          <Link to="/commerce">Commerce</Link>; contacts and consent on{' '}
          <Link to="/commerce/audience">Audience</Link>.
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

        {memberships.length === 0 && (
          <section className={styles.card}>
            <p className={styles.muted}>
              You do not belong to an organization yet. Create one on{' '}
              <Link to="/commerce">Commerce</Link>, or accept an invite from its owner.
            </p>
          </section>
        )}

        {orgId !== null && (
          <>
            <section className={styles.card}>
              <h2 className={styles.cardTitle}>Members</h2>
              <div className={styles.list}>
                {members.map((member) => (
                  <div key={member.id} className={styles.listRow}>
                    <span>
                      <strong>{member.displayName}</strong>{' '}
                      <span className={styles.muted}>{member.email}</span>
                    </span>
                    {isAdmin ? (
                      <span className={styles.row}>
                        <select
                          className={styles.select}
                          value={member.role}
                          // An admin cannot touch an owner in either direction; the server enforces
                          // it (OWNER_ROLE_REQUIRED), the disabled control is just the honest UI.
                          disabled={member.role === 'owner' && !isOwner}
                          onChange={(e) => void changeRole(member.id, toRole(e.target.value))}
                        >
                          {/* The member's current role always renders, even when the caller could
                              not assign it — otherwise the select would lie about what they hold. */}
                          {ORG_ROLES.filter((r) => assignableRoles.includes(r) || r === member.role).map(
                            (r) => (
                              <option key={r} value={r}>
                                {r}
                              </option>
                            ),
                          )}
                        </select>
                        <button
                          type="button"
                          className={styles.ghost}
                          disabled={member.role === 'owner' && !isOwner}
                          onClick={() => void removeMember(member)}
                        >
                          Remove
                        </button>
                      </span>
                    ) : (
                      <span className={styles.tag}>{member.role}</span>
                    )}
                  </div>
                ))}
              </div>
            </section>

            {isAdmin && (
              <section className={styles.card}>
                <h2 className={styles.cardTitle}>Invite someone</h2>
                <p className={styles.muted}>
                  They get an email with an accept link that works for seven days, only for a Stewra
                  account on that address. {isOwner ? '' : 'Only an owner can invite another owner.'}
                </p>
                <div className={styles.row}>
                  <input
                    className={styles.input}
                    type="email"
                    placeholder="colleague@example.com"
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                  />
                  <select
                    className={styles.select}
                    value={inviteRole}
                    onChange={(e) => setInviteRole(toRole(e.target.value))}
                  >
                    {assignableRoles.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className={styles.primary}
                    disabled={inviting || inviteEmail.trim() === ''}
                    onClick={() => void sendInvite()}
                  >
                    {inviting ? 'Sending…' : 'Send invite'}
                  </button>
                </div>

                {invites.length > 0 && (
                  <div className={styles.list}>
                    {invites.map((invite) => (
                      <div key={invite.id} className={styles.listRow}>
                        <span>
                          {invite.email} <span className={styles.tag}>{invite.role}</span>{' '}
                          <span className={styles.muted}>
                            expires {new Date(invite.expiresAt).toLocaleDateString()}
                          </span>
                        </span>
                        <button
                          type="button"
                          className={styles.ghost}
                          onClick={() => void revokeInvite(invite.id)}
                        >
                          Revoke
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
