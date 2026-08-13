import { useCallback, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { AcceptOrgInviteResponse } from '@stewra/shared-types';
import { useAuth } from '../../hooks/useAuth';
import { api } from '../../services/api';
import { AppNav } from '../../components/AppNav/AppNav';
import styles from './CommercePage.module.css';

/**
 * Where the invite email's link lands: `/invites/accept?token=…`.
 *
 * Deliberately NOT wrapped in ProtectedRoute — its redirect to /login would drop the query string,
 * and the token in it is the entire invite. Signed out, this page keeps the token in its own URL and
 * hands /login a `next` back to itself; signed in, it still waits for a click. Accepting on mount
 * would make opening an email link a membership-granting side effect, and joining an organization
 * that can message a business's whole customer list deserves a deliberate yes.
 */
export default function InviteAcceptPage(): React.JSX.Element {
  const { user, loading } = useAuth();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');

  const [accepted, setAccepted] = useState<AcceptOrgInviteResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const accept = useCallback(async (): Promise<void> => {
    if (token === null) return;
    setWorking(true);
    setError(null);
    try {
      setAccepted(await api.acceptOrgInvite({ token }));
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'That invite could not be accepted. It may have expired or been revoked.',
      );
    } finally {
      setWorking(false);
    }
  }, [token]);

  const body = (): React.JSX.Element => {
    if (loading) {
      return <p className={styles.muted}>Loading…</p>;
    }
    if (token === null) {
      return (
        <p className={styles.muted}>
          This page needs the link from your invitation email — open the email and follow its
          “Accept invitation” link.
        </p>
      );
    }
    if (user === null) {
      const next = encodeURIComponent(`/invites/accept?token=${encodeURIComponent(token)}`);
      return (
        <>
          <p className={styles.muted}>
            You&apos;ve been invited to join an organization on Stewra. Sign in — or create an
            account on the email address the invite was sent to — and you&apos;ll come straight
            back here.
          </p>
          <Link className={styles.primary} to={`/login?next=${next}`}>
            Sign in to continue
          </Link>
        </>
      );
    }
    if (accepted !== null) {
      return (
        <>
          <p>
            You&apos;ve joined <strong>{accepted.org.name}</strong> as{' '}
            <strong>{accepted.role}</strong>.
          </p>
          <Link className={styles.primary} to="/commerce">
            Open Commerce
          </Link>
        </>
      );
    }
    return (
      <>
        <p className={styles.muted}>
          Accepting adds you to the organization this invite was minted for, with the role its
          sender chose. The invite only works for the account whose email it was addressed to.
        </p>
        {error !== null && <div className={styles.error}>{error}</div>}
        <button type="button" className={styles.primary} disabled={working} onClick={() => void accept()}>
          {working ? 'Accepting…' : 'Accept invitation'}
        </button>
      </>
    );
  };

  return (
    <div className={styles.page}>
      {user !== null && <AppNav />}
      <main className={styles.main}>
        <h1 className={styles.title}>Organization invite</h1>
        <section className={styles.card}>{body()}</section>
      </main>
    </div>
  );
}
