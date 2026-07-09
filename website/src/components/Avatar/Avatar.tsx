import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { fetchMediaObjectUrl } from '../../services/api';
import styles from './Avatar.module.css';

interface AvatarProps {
  /** The user's display name — drives the initials fallback and the alt text. */
  readonly name: string;
  /** Relative `/media/:id` URL of the profile photo, or null for the initials fallback. */
  readonly avatarUrl?: string | null;
  /** Rendered diameter in px (default 36). */
  readonly size?: number;
  readonly className?: string;
}

/** Up to two uppercase initials from a display name (e.g. "Ada Lovelace" → "AL"). */
function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase())
    .join('')
    .slice(0, 2);
}

/**
 * A user's profile photo with an initial-letter fallback. Avatars live behind the authenticated
 * `/media/:id` route, so we resolve the URL to an object URL through `fetchMediaObjectUrl` (which
 * attaches the bearer token) and revoke it on unmount. Any load failure falls back to initials.
 */
export function Avatar({ name, avatarUrl, size = 36, className }: AvatarProps): React.JSX.Element {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (avatarUrl === null || avatarUrl === undefined || avatarUrl === '') {
      setObjectUrl(null);
      return;
    }
    let revoked = false;
    let created: string | null = null;
    fetchMediaObjectUrl(avatarUrl)
      .then((url) => {
        if (revoked) {
          URL.revokeObjectURL(url);
          return;
        }
        created = url;
        setObjectUrl(url);
      })
      .catch(() => setObjectUrl(null));
    return () => {
      revoked = true;
      if (created !== null) URL.revokeObjectURL(created);
    };
  }, [avatarUrl]);

  const style = { width: size, height: size, fontSize: Math.round(size * 0.4) };
  return (
    <span className={clsx(styles.avatar, className)} style={style} title={name}>
      {objectUrl !== null ? (
        <img src={objectUrl} alt={name} className={styles.image} />
      ) : (
        <span className={styles.initials}>{initialsOf(name)}</span>
      )}
    </span>
  );
}

export default Avatar;
