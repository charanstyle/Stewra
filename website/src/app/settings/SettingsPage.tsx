import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountDeletionPreview, UserPreferences } from '@stewra/shared-types';
import { AppNav } from '../../components/AppNav/AppNav';
import { Avatar } from '../../components/Avatar/Avatar';
import { useAuth } from '../../hooks/useAuth';
import { api } from '../../services/api';
import styles from './SettingsPage.module.css';

/**
 * Profile + privacy settings: profile photo upload, the read-receipt sharing toggle, and permanent
 * account deletion.
 *
 * The deletion half mirrors the mobile `DeleteAccountCard` step for step — preview first, password
 * second — because they are the same promise made on two surfaces, and the public
 * `/account-deletion` page describes both. If one changes, all three do.
 */
export default function SettingsPage(): React.JSX.Element {
  const { user, applyUser, logout } = useAuth();
  const [prefs, setPrefs] = useState<UserPreferences | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [deletionPreview, setDeletionPreview] = useState<AccountDeletionPreview | null>(null);
  const [password, setPassword] = useState('');
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    api
      .getPreferences()
      .then((res) => setPrefs(res.preferences))
      .catch(() => setError('Failed to load settings'));
  }, []);

  const onPickFile = useCallback(
    async (file: File | undefined): Promise<void> => {
      if (file === undefined) return;
      setBusy(true);
      setError(null);
      try {
        await api.uploadAvatar(file, file.name);
        // Re-fetch the self profile so the new avatarUrl propagates everywhere (nav, chat header).
        const me = await api.me();
        applyUser(me.user);
      } catch {
        setError('Could not upload the photo. Try a JPEG or PNG under the size limit.');
      } finally {
        setBusy(false);
      }
    },
    [applyUser],
  );

  const toggleReceipts = useCallback(async (): Promise<void> => {
    if (prefs === null) return;
    const nextValue = !prefs.readReceiptsEnabled;
    setPrefs({ ...prefs, readReceiptsEnabled: nextValue });
    try {
      const res = await api.updatePreferences({ readReceiptsEnabled: nextValue });
      setPrefs(res.preferences);
    } catch {
      setPrefs({ ...prefs, readReceiptsEnabled: !nextValue });
      setError('Could not update your read-receipt setting');
    }
  }, [prefs]);

  const openDeletion = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const res = await api.getAccountDeletionPreview();
      setDeletionPreview(res.preview);
    } catch {
      setError('Could not check what deleting your account would remove');
    }
  }, []);

  const confirmDeletion = useCallback(async (): Promise<void> => {
    setDeleting(true);
    setError(null);
    try {
      const res = await api.deleteAccount({ password });
      // The user's last chance to hear that a grant may still be live somewhere — there is no
      // account to sign back into and ask afterwards.
      const unconfirmed = res.result.revocations.filter((r) => !r.confirmed);
      if (unconfirmed.length > 0) {
        window.alert(
          'Your account and its data are gone. We could not confirm these were disconnected, ' +
            'so please check them in that provider’s own security settings:\n\n' +
            unconfirmed.map((r) => `• ${r.target}`).join('\n'),
        );
      }
      logout();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete your account');
      setDeleting(false);
    }
  }, [password, logout]);

  const blocked = deletionPreview !== null && deletionPreview.blockers.length > 0;

  return (
    <div className={styles.page}>
      <AppNav />
      <div className={styles.content}>
        <h1 className={styles.heading}>Settings</h1>
        {error && <div className={styles.error}>{error}</div>}

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Profile photo</h2>
          <div className={styles.avatarRow}>
            <Avatar name={user?.displayName ?? '?'} avatarUrl={user?.avatarUrl ?? null} size={72} />
            <div>
              <button
                type="button"
                className={styles.button}
                disabled={busy}
                onClick={() => fileRef.current?.click()}
              >
                {busy ? 'Uploading…' : 'Change photo'}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className={styles.hiddenInput}
                onChange={(e) => void onPickFile(e.target.files?.[0])}
              />
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Privacy</h2>
          <label className={styles.toggleRow}>
            <div className={styles.toggleText}>
              <span className={styles.toggleLabel}>Read receipts</span>
              <span className={styles.toggleHint}>
                When off, you won’t send read receipts — and you won’t see others’ either.
              </span>
            </div>
            <input
              type="checkbox"
              className={styles.checkbox}
              checked={prefs?.readReceiptsEnabled ?? true}
              disabled={prefs === null}
              onChange={() => void toggleReceipts()}
            />
          </label>
        </section>

        <section className={styles.dangerSection}>
          <h2 className={styles.dangerTitle}>Danger zone</h2>
          <p className={styles.dangerHint}>
            Deleting your account permanently removes your messages, memories, connected accounts and
            files. This cannot be undone — see{' '}
            <a href="/account-deletion">what deletion removes</a>.
          </p>

          {deletionPreview === null ? (
            <button
              type="button"
              className={styles.dangerButton}
              onClick={() => void openDeletion()}
              data-testid="settings-delete-account"
            >
              Delete account
            </button>
          ) : (
            <>
              {deletionPreview.blockers.map((blocker) => (
                <div key={blocker.orgName} className={styles.blockerBox}>
                  {blocker.detail}
                </div>
              ))}

              {deletionPreview.orgsToDelete.length > 0 && (
                <div className={styles.warnBox}>
                  <strong>These will be deleted with you</strong>
                  <ul>
                    {deletionPreview.orgsToDelete.map((name) => (
                      <li key={name}>
                        {name} — you are its only member, so its customers, campaigns and history go
                        too.
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {deletionPreview.storeSubscriptions.length > 0 && (
                <div className={styles.warnBox}>
                  <strong>You will still be billed</strong>
                  <ul>
                    {deletionPreview.storeSubscriptions.map((name) => (
                      <li key={name}>{name}</li>
                    ))}
                    <li>
                      Deleting your account does not cancel a store subscription — only the App Store
                      or Google Play can. Cancel it there first, or you will keep being charged.
                    </li>
                  </ul>
                </div>
              )}

              {deletionPreview.orgsToLeave.length > 0 && (
                <p className={styles.dangerHint}>
                  You will be removed from: {deletionPreview.orgsToLeave.join(', ')}. Those
                  organizations continue without you.
                </p>
              )}

              {!blocked && (
                <input
                  type="password"
                  className={styles.passwordInput}
                  placeholder="Enter your password to confirm"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  data-testid="delete-account-password"
                />
              )}

              <div className={styles.confirmRow}>
                <button
                  type="button"
                  className={styles.button}
                  disabled={deleting}
                  onClick={() => {
                    setDeletionPreview(null);
                    setPassword('');
                  }}
                >
                  Cancel
                </button>
                {!blocked && (
                  <button
                    type="button"
                    className={styles.confirmButton}
                    disabled={deleting || password.length === 0}
                    onClick={() => void confirmDeletion()}
                    data-testid="delete-account-confirm"
                  >
                    {deleting ? 'Deleting…' : 'Delete forever'}
                  </button>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
