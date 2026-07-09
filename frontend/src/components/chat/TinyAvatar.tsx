import React, { useEffect, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { fetchAuthedMediaFile } from '../../services/api';
import { theme } from '../../theme/colors';

interface TinyAvatarProps {
  /** The user's display name — drives the initials fallback. */
  readonly name: string;
  /** Relative `/media/:id` URL of the profile photo, or null for the initials fallback. */
  readonly avatarUrl?: string | null;
  /** Rendered diameter in px (default 28). */
  readonly size?: number;
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

/** The `/media/:id` id from an avatar URL, for a stable cache filename (or the whole url as a fallback). */
function assetIdOf(url: string): string {
  const parts = url.split('/');
  return parts[parts.length - 1] || url;
}

/**
 * A user's profile photo with an initial-letter fallback. Avatars live behind the authenticated
 * `/media/:id` route, so we download the image once (bearer token attached) to a cached file via
 * `fetchAuthedMediaFile` and render it from the local uri. Any load failure falls back to initials.
 */
export function TinyAvatar({ name, avatarUrl, size = 28 }: TinyAvatarProps): React.JSX.Element {
  const [localUri, setLocalUri] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (avatarUrl === null || avatarUrl === undefined || avatarUrl === '') {
      setLocalUri(null);
      return;
    }
    fetchAuthedMediaFile(avatarUrl, assetIdOf(avatarUrl))
      .then((uri) => {
        if (active) setLocalUri(uri);
      })
      .catch(() => {
        if (active) setLocalUri(null);
      });
    return () => {
      active = false;
    };
  }, [avatarUrl]);

  const dimension = { width: size, height: size, borderRadius: size / 2 };
  if (localUri !== null) {
    return <Image source={{ uri: localUri }} style={[styles.image, dimension]} />;
  }
  return (
    <View style={[styles.fallback, dimension]}>
      <Text style={[styles.initials, { fontSize: Math.round(size * 0.4) }]}>{initialsOf(name)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  image: {
    backgroundColor: theme.colors.surfaceAlt,
  },
  fallback: {
    backgroundColor: theme.colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  initials: {
    color: theme.colors.textSecondary,
    fontWeight: '600',
  },
});

export default TinyAvatar;
