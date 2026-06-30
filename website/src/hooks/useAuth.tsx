import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import type { User } from '@stewra/shared-types';
import { api, clearTokens, readTokens, writeTokens } from '../services/api';

interface AuthContextValue {
  readonly user: User | null;
  readonly loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  /** Resolves to true when the new account still needs email verification. */
  register: (email: string, password: string, displayName: string) => Promise<boolean>;
  logout: () => void;
  /** Replace the cached user (e.g. after the email is verified). */
  applyUser: (user: User) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // On boot, if we hold a token, resolve the current user; otherwise we're simply logged out.
  useEffect(() => {
    if (readTokens() === null) {
      setLoading(false);
      return;
    }
    api
      .me()
      .then((res) => setUser(res.user))
      .catch(() => {
        clearTokens();
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string): Promise<void> => {
    const res = await api.login({ email, password });
    writeTokens(res.tokens);
    setUser(res.user);
  }, []);

  const register = useCallback(
    async (email: string, password: string, displayName: string): Promise<boolean> => {
      const res = await api.register({ email, password, displayName });
      writeTokens(res.tokens);
      setUser(res.user);
      return res.requiresVerification;
    },
    [],
  );

  const logout = useCallback((): void => {
    clearTokens();
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

/** Gates a route behind authentication; redirects to /login when there is no user. */
export function ProtectedRoute({ children }: { children: ReactNode }): React.JSX.Element {
  const { user, loading } = useAuth();
  if (loading) {
    return <div style={{ padding: 24 }}>Loading…</div>;
  }
  if (user === null) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}
