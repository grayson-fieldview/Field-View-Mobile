import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  ApiError,
  api,
  clearSession,
  loadSession,
  normalizeUser,
  type BackendUser,
} from "@/services/api";

export interface AuthUser {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  name: string;
}

interface AuthState {
  user: AuthUser | null;
  ready: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (
    firstName: string,
    lastName: string,
    email: string,
    password: string,
  ) => Promise<void>;
  signOut: () => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

function toAuthUser(raw: BackendUser | null): AuthUser | null {
  if (!raw) return null;
  const first = raw.firstName ?? "";
  const last = raw.lastName ?? "";
  const combined = `${first} ${last}`.trim();
  return {
    id: String(raw.id),
    email: String(raw.email),
    firstName: raw.firstName,
    lastName: raw.lastName,
    name: raw.name ? String(raw.name) : combined || String(raw.email),
  };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [ready, setReady] = useState(false);

  const bootstrap = useCallback(async () => {
    try {
      await loadSession();
      const me = await api.me().catch((e) => {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      });
      setUser(toAuthUser(normalizeUser(me)));
    } catch {
      // Network/other error on launch — treat as signed out.
      setUser(null);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  const refreshUser = useCallback(async () => {
    const me = await api.me().catch(() => null);
    setUser(toAuthUser(normalizeUser(me)));
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const emailTrim = email.trim();
    if (!emailTrim) throw new Error("Please enter your email.");
    if (!password) throw new Error("Please enter your password.");
    const loginRes = await api.login(emailTrim, password);
    // The session cookie is now set. Fetch the canonical user record.
    let me = normalizeUser(loginRes);
    if (!me) me = normalizeUser(await api.me().catch(() => null));
    if (!me) throw new Error("Sign-in succeeded but we couldn't load your account.");
    setUser(toAuthUser(me));
  }, []);

  const signUp = useCallback(
    async (
      firstName: string,
      lastName: string,
      email: string,
      password: string,
    ) => {
      if (!firstName.trim()) throw new Error("Please enter your first name.");
      if (!lastName.trim()) throw new Error("Please enter your last name.");
      if (!/^\S+@\S+\.\S+$/.test(email.trim()))
        throw new Error("Enter a valid email address.");
      if (password.length < 8)
        throw new Error("Password must be at least 8 characters.");

      const regRes = await api.register({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim(),
        password,
      });
      let me = normalizeUser(regRes);
      // Some backends require a follow-up login after register.
      if (!me) {
        await api.login(email.trim(), password).catch(() => null);
        me = normalizeUser(await api.me().catch(() => null));
      }
      if (!me)
        throw new Error(
          "Account created but sign-in failed — please try signing in.",
        );
      setUser(toAuthUser(me));
    },
    [],
  );

  const signOut = useCallback(async () => {
    await api.logout().catch(() => null);
    await clearSession();
    setUser(null);
  }, []);

  const requestPasswordReset = useCallback(async (email: string) => {
    // No backend endpoint confirmed for this yet — surface a friendly message.
    if (!/^\S+@\S+\.\S+$/.test(email.trim()))
      throw new Error("Enter a valid email address.");
    throw new Error(
      "Password reset isn’t wired up yet. Please reset from the web app at field-view.com for now.",
    );
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      user,
      ready,
      signIn,
      signUp,
      signOut,
      requestPasswordReset,
      refreshUser,
    }),
    [user, ready, signIn, signUp, signOut, requestPasswordReset, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
