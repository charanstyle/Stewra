import * as SecureStore from 'expo-secure-store';
import type { AuthTokens } from '@stewra/shared-types';

/**
 * Persists the access/refresh token pair in the platform keychain/keystore via
 * expo-secure-store (never AsyncStorage — tokens are secrets). Mirrors
 * website/src/services/api.ts's localStorage-backed `readTokens`/`writeTokens`,
 * but every read/write is async because SecureStore is native-backed.
 */
const TOKEN_KEY = 'stewra.tokens';

interface StoredTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
}

function isStoredTokens(value: unknown): value is StoredTokens {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (!('accessToken' in value) || !('refreshToken' in value)) {
    return false;
  }
  return typeof value.accessToken === 'string' && typeof value.refreshToken === 'string';
}

export async function readTokens(): Promise<AuthTokens | null> {
  const raw = await SecureStore.getItemAsync(TOKEN_KEY);
  if (raw === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isStoredTokens(parsed)) {
    return null;
  }
  return parsed;
}

export async function writeTokens(tokens: AuthTokens): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, JSON.stringify(tokens));
}

export async function clearTokens(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
}
