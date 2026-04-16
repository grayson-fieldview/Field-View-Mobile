import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { setAuthToken } from "@/services/api";
import { newId } from "@/services/id";
import { storage } from "@/services/storage";
import type { User } from "@/services/types";

interface AuthState {
  user: User | null;
  ready: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (name: string, email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      const [u, t] = await Promise.all([storage.getUser(), storage.getToken()]);
      if (t) setAuthToken(t);
      setUser(u);
      setReady(true);
    })();
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const emailLower = email.trim().toLowerCase();
    const users = await storage.getRegisteredUsers();
    const found = users.find((u) => u.email === emailLower);
    if (!found) throw new Error("No account found for that email.");
    if (found.password !== password) throw new Error("Incorrect password.");
    const { password: _pw, ...safe } = found;
    await storage.setUser(safe);
    const token = newId();
    await storage.setToken(token);
    setAuthToken(token);
    setUser(safe);
  }, []);

  const signUp = useCallback(
    async (name: string, email: string, password: string) => {
      const emailLower = email.trim().toLowerCase();
      if (!name.trim()) throw new Error("Please enter your name.");
      if (!/^\S+@\S+\.\S+$/.test(emailLower))
        throw new Error("Enter a valid email address.");
      if (password.length < 6)
        throw new Error("Password must be at least 6 characters.");
      const users = await storage.getRegisteredUsers();
      if (users.some((u) => u.email === emailLower))
        throw new Error("An account with that email already exists.");
      const fresh: User = {
        id: newId(),
        email: emailLower,
        name: name.trim(),
        createdAt: new Date().toISOString(),
      };
      await storage.setRegisteredUsers([...users, { ...fresh, password }]);
      await storage.setUser(fresh);
      const token = newId();
      await storage.setToken(token);
      setAuthToken(token);
      setUser(fresh);
    },
    [],
  );

  const signOut = useCallback(async () => {
    await storage.clearSession();
    setAuthToken(null);
    setUser(null);
  }, []);

  const requestPasswordReset = useCallback(async (email: string) => {
    const emailLower = email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(emailLower))
      throw new Error("Enter a valid email address.");
    // Offline mode: pretend to email the link.
    await new Promise((r) => setTimeout(r, 600));
  }, []);

  const value = useMemo(
    () => ({ user, ready, signIn, signUp, signOut, requestPasswordReset }),
    [user, ready, signIn, signUp, signOut, requestPasswordReset],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
