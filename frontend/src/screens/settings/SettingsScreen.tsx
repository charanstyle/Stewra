import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import type { UserPreferences } from '@stewra/shared-types';
import { useAuth } from '../../contexts/AuthContext';
import { api } from '../../services/api';
import { theme } from '../../theme/colors';
import { TinyAvatar } from '../../components/chat/TinyAvatar';

/** Derive an upload filename + MIME from a picked asset, falling back to JPEG when the picker omits them. */
function fileMetaFor(asset: ImagePicker.ImagePickerAsset): { fileName: string; mimeType: string } {
  const mimeType = asset.mimeType ?? 'image/jpeg';
  if (asset.fileName) {
    return { fileName: asset.fileName, mimeType };
  }
  const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
  return { fileName: `avatar.${ext}`, mimeType };
}

/**
 * Profile + privacy settings. Renders the user's current avatar, lets the user pick a new profile
 * photo from their library (expo-image-picker → POST /users/me/avatar), and exposes the read-receipt
 * sharing toggle (mirrors the web).
 */
export default function SettingsScreen(): React.JSX.Element {
  const { user, applyUser } = useAuth();
  const [prefs, setPrefs] = useState<UserPreferences | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    api
      .getPreferences()
      .then((res) => setPrefs(res.preferences))
      .catch(() => setError('Failed to load settings'));
  }, []);

  const changePhoto = async (): Promise<void> => {
    if (uploading) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset || user === null) return;
    setError(null);
    setUploading(true);
    try {
      const { fileName, mimeType } = fileMetaFor(asset);
      const res = await api.uploadAvatar(asset.uri, fileName, mimeType);
      applyUser({ ...user, avatarUrl: res.avatarUrl });
    } catch {
      setError('Could not update your profile photo');
    } finally {
      setUploading(false);
    }
  };

  const toggleReceipts = async (next: boolean): Promise<void> => {
    if (prefs === null) return;
    setPrefs({ ...prefs, readReceiptsEnabled: next });
    try {
      const res = await api.updatePreferences({ readReceiptsEnabled: next });
      setPrefs(res.preferences);
    } catch {
      setPrefs({ ...prefs, readReceiptsEnabled: !next });
      setError('Could not update your read-receipt setting');
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Profile</Text>
          <View style={styles.profileRow}>
            <TinyAvatar name={user?.displayName ?? '?'} avatarUrl={user?.avatarUrl ?? null} size={64} />
            <View style={styles.profileText}>
              <Text style={styles.name}>{user?.displayName ?? ''}</Text>
              <Text style={styles.email}>{user?.email ?? ''}</Text>
            </View>
          </View>
          <Pressable
            accessibilityRole="button"
            disabled={uploading}
            onPress={() => void changePhoto()}
            style={({ pressed }) => [styles.photoButton, pressed && styles.photoButtonPressed]}
          >
            {uploading ? (
              <ActivityIndicator color={theme.colors.primary} />
            ) : (
              <Text style={styles.photoButtonText}>Change photo</Text>
            )}
          </Pressable>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Privacy</Text>
          <View style={styles.toggleRow}>
            <View style={styles.toggleText}>
              <Text style={styles.toggleLabel}>Read receipts</Text>
              <Text style={styles.toggleHint}>
                When off, you won’t send read receipts — and you won’t see others’ either.
              </Text>
            </View>
            <Switch
              value={prefs?.readReceiptsEnabled ?? true}
              disabled={prefs === null}
              onValueChange={(next) => void toggleReceipts(next)}
              trackColor={{ true: theme.colors.primary, false: theme.colors.border }}
            />
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  content: {
    padding: theme.spacing.md,
    gap: theme.spacing.md,
  },
  section: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.md,
  },
  sectionTitle: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: theme.spacing.sm,
  },
  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
  },
  profileText: {
    flex: 1,
  },
  photoButton: {
    marginTop: theme.spacing.md,
    height: 40,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoButtonPressed: {
    opacity: 0.7,
  },
  photoButtonText: {
    color: theme.colors.primary,
    fontSize: 15,
    fontWeight: '600',
  },
  name: {
    color: theme.colors.textPrimary,
    fontSize: 16,
    fontWeight: '600',
  },
  email: {
    color: theme.colors.textSecondary,
    fontSize: 13,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.md,
  },
  toggleText: {
    flex: 1,
  },
  toggleLabel: {
    color: theme.colors.textPrimary,
    fontSize: 15,
  },
  toggleHint: {
    color: theme.colors.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  error: {
    color: theme.colors.danger,
    fontSize: 13,
  },
});
