import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { EMAIL_VERIFICATION_CODE_LENGTH } from '@stewra/shared-types';
import { useAuth } from '../../hooks/useAuth';
import { api, ApiError } from '../../services/api';
import styles from './VerifyEmailPage.module.css';

export default function VerifyEmailPage(): React.JSX.Element {
  const navigate = useNavigate();
  const { user, applyUser } = useAuth();
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // If the user is already verified (e.g. landed here by mistake), send them on.
  useEffect(() => {
    if (user !== null && user.emailVerified) {
      navigate('/activity', { replace: true });
    }
  }, [user, navigate]);

  const onlyDigits = (raw: string): string =>
    raw.replace(/\D/g, '').slice(0, EMAIL_VERIFICATION_CODE_LENGTH);

  const onSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    if (code.length !== EMAIL_VERIFICATION_CODE_LENGTH) {
      setError(`Enter the ${EMAIL_VERIFICATION_CODE_LENGTH}-digit code from your email.`);
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.verifyEmail({ code });
      applyUser(res.user);
      navigate('/activity', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  };

  const onResend = async (): Promise<void> => {
    setError(null);
    setNotice(null);
    setResending(true);
    try {
      await api.resendVerification();
      setNotice('A fresh code is on its way. Check your inbox.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setResending(false);
    }
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <h1 className={styles.brand}>Verify your email</h1>
        <p className={styles.tagline}>
          We sent a {EMAIL_VERIFICATION_CODE_LENGTH}-digit code to{' '}
          <strong>{user?.email ?? 'your email'}</strong>. Enter it below to finish setting up your
          account. Nothing connects until you do.
        </p>

        <form onSubmit={(e) => void onSubmit(e)} className={styles.form}>
          <label className={styles.field}>
            <span>Verification code</span>
            <input
              className={styles.codeInput}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              placeholder="000000"
              value={code}
              onChange={(e) => setCode(onlyDigits(e.target.value))}
            />
          </label>

          {error && <div className={styles.serverErr}>{error}</div>}
          {notice && <div className={styles.notice}>{notice}</div>}

          <button
            type="submit"
            className={styles.submit}
            disabled={submitting || code.length !== EMAIL_VERIFICATION_CODE_LENGTH}
          >
            {submitting ? 'Verifying…' : 'Verify email'}
          </button>
        </form>

        <button type="button" className={styles.resend} onClick={() => void onResend()} disabled={resending}>
          {resending ? 'Sending…' : "Didn't get it? Send a new code"}
        </button>
      </div>
    </div>
  );
}
