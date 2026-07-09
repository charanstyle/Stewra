import { useCallback, useEffect, useRef, useState } from 'react';
import type { UserPreferences } from '@stewra/shared-types';
import { AppNav } from '../../components/AppNav/AppNav';
import { Avatar } from '../../components/Avatar/Avatar';
import { useAuth } from '../../hooks/useAuth';
import { api } from '../../services/api';
import styles from './SettingsPage.module.css';

/** Profile + privacy settings: profile photo upload and the read-receipt sharing toggle. */
export default function SettingsPage(): React.JSX.Element {
  const { user, applyUser } = useAuth();
  const [prefs, setPrefs] = useState<UserPreferences | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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
      </div>
    </div>
  );
}
