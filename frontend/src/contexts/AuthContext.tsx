import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { User } from '@stewra/shared-types';
import { api } from '../services/api';
import { clearTokens, readTokens, writeTokens } from '../services/tokenStore';
import { disconnectSocket } from '../services/socket';

interface AuthContextValue {
  readonly user: User | null;
  readonly loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  /** Resolves to true when the new account still needs email verification. */
  register: (email: string, password: string, displayName: string) => Promise<boolean>;
  logout: () => Promise<void>;
  /** Replace the cached user (e.g. after the email is verified). */
  applyUser: (user: User) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async (): Promise<void> => {
      const tokens = await readTokens();
      if (!tokens) {
        if (!cancelled) {
          setLoading(false);
        }
        return;
      }
      try {
        const res = await api.me();
        if (!cancelled) {
          setUser(res.user);
        }
      } catch {
        await clearTokens();
        if (!cancelled) {
          setUser(null);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string): Promise<void> => {
    const res = await api.login({ email, password });
    await writeTokens(res.tokens);
    setUser(res.user);
  }, []);

  const register = useCallback(
    async (email: string, password: string, displayName: string): Promise<boolean> => {
      const res = await api.register({ email, password, displayName });
      await writeTokens(res.tokens);
      setUser(res.user);
      return res.requiresVerification;
    },
    [],
  );

  const logout = useCallback(async (): Promise<void> => {
    // Best-effort teardown: neither the socket disconnect nor the token wipe may
    // throw, or the sign-out would abort and (on a release build) silently strand
    // the user logged in. Whatever happens, we still null the user so the
    // navigator swaps to Login.
    try {
      disconnectSocket();
    } catch {
      // socket already gone — ignore
    }
    try {
      await clearTokens();
    } catch {
      // secure-store wipe failed; the user is still signed out locally and the
      // next app launch will re-validate and clear stale tokens
    }
    setUser(null);
  }, []);

  const applyUser = useCallback((next: User): void => {
    setUser(next);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, applyUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === null) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
