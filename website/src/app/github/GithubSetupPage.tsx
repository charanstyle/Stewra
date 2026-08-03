import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { githubAppService } from '../../services/githubAppService';
import { ApiError } from '../../services/api';
import styles from './GithubSetupPage.module.css';

/**
 * The GitHub App's "Setup URL" target. After the user click-installs the Stewra App on their chosen
 * repositories, GitHub redirects here with `?installation_id=` and echoes back the signed `state` the
 * backend minted into the install link. This page's whole job is to hand that pair to the backend —
 * which verifies the state belongs to the signed-in user and the installation is real before storing
 * the link — then send the user back to the Runners panel in Activity.
 *
 * GitHub can also land here with `setup_action=request` and NO installation id: the user requested the
 * App on an org they don't admin, and an owner has to approve it first. That is a waiting state, not an
 * error, and is reported truthfully.
 */
type Phase =
  | { kind: 'linking' }
  | { kind: 'done'; accountLogin: string; repoCount: number }
  | { kind: 'pending-approval' }
  | { kind: 'invalid'; message: string }
  | { kind: 'error'; message: string };

export default function GithubSetupPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [phase, setPhase] = useState<Phase>({ kind: 'linking' });
  // React StrictMode runs effects twice in dev; the link must be posted exactly once.
  const posted = useRef(false);

  useEffect(() => {
    if (posted.current) {
      return;
    }
    posted.current = true;

    if (params.get('setup_action') === 'request') {
      setPhase({ kind: 'pending-approval' });
      return;
    }

    const installationId = Number(params.get('installation_id'));
    const state = params.get('state');
    if (!Number.isInteger(installationId) || installationId <= 0 || state === null || state === '') {
      setPhase({
        kind: 'invalid',
        message:
          'This page is the return leg of a GitHub App install and cannot be opened directly. Start from Activity → Runners → Connect GitHub.',
      });
      return;
    }

    void (async (): Promise<void> => {
      try {
        const result = await githubAppService.linkInstallation({ installationId, state });
        setPhase({ kind: 'done', accountLogin: result.accountLogin, repoCount: result.repos.length });
      } catch (err) {
        setPhase({
          kind: 'error',
          message: err instanceof ApiError ? err.message : 'Something went wrong linking GitHub',
        });
      }
    })();
  }, [params]);

  // Let the success state be read, then land the user where the connection is used.
  useEffect(() => {
    if (phase.kind !== 'done') {
      return;
    }
    const timer = setTimeout(() => {
      navigate('/activity', { replace: true });
    }, 1500);
    return (): void => clearTimeout(timer);
  }, [phase, navigate]);

  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <h1 className={styles.brand}>Connect GitHub</h1>

        {phase.kind === 'linking' && (
          <>
            <p className={styles.tagline}>
              GitHub sent you back with an installation. Confirming it and linking it to your account…
            </p>
            <div className={styles.spinnerRow}>
              <span className={styles.spinner} aria-hidden="true" />
              Linking your installation…
            </div>
          </>
        )}

        {phase.kind === 'done' && (
          <>
            <div className={styles.notice}>
              GitHub is connected: <strong>{phase.accountLogin}</strong>. Your cloud runner can now work
              with the repositories you granted.
            </div>
            <p className={styles.repoCount}>
              {phase.repoCount === 1 ? '1 repository granted.' : `${phase.repoCount} repositories granted.`}{' '}
              Taking you to Runners…
            </p>
          </>
        )}

        {phase.kind === 'pending-approval' && (
          <>
            <div className={styles.notice}>
              Your request to install the Stewra app is waiting for an owner of that GitHub organization
              to approve it. Once they do, run the install from Activity → Runners again to finish
              connecting.
            </div>
            <Link className={styles.back} to="/activity">
              Back to Activity
            </Link>
          </>
        )}

        {(phase.kind === 'invalid' || phase.kind === 'error') && (
          <>
            <div className={styles.serverErr}>{phase.message}</div>
            <Link className={styles.back} to="/activity">
              Back to Activity
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
