import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState } from "react-native";

import {
  ApiError,
  api,
  clearSession,
  loadSession,
  normalizeUser,
  type BackendUser,
  type UserRole,
} from "@/services/api";
import { autoTrackingPref } from "@/services/preferences";
import {
  registerForPushNotificationsAsync,
  registerPushTokenWithServer,
  subscribeToPushTokenRotation,
  unregisterPushTokenWithServer,
} from "@/services/pushNotifications";

export interface AuthUser {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  name: string;
  /** True when this user owns their account (can delete the whole account). */
  isOwner: boolean;
  /**
   * Account role from the web backend. `null` when the server didn't
   * return a role (legacy user rows pre-Team-rework). All admin-only
   * UI must treat `null` as non-admin.
   */
  role: UserRole | null;
  /**
   * Auto clock-in/out master switch (S33). Default true on null/missing
   * from the server. Mirrored to AsyncStorage via autoTrackingPref so
   * the background geofence task can read it without React context.
   */
  autoTrackingEnabled: boolean;
}

interface AuthState {
  user: AuthUser | null;
  ready: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
  refreshUser: () => Promise<void>;
  updatePreferences: (input: { autoTrackingEnabled?: boolean }) => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

function toAuthUser(raw: BackendUser | null): AuthUser | null {
  if (!raw) return null;
  const first = raw.firstName ?? "";
  const last = raw.lastName ?? "";
  const combined = `${first} ${last}`.trim();
  const validRoles: UserRole[] = ["admin", "manager", "standard", "restricted"];
  const role: UserRole | null =
    typeof raw.role === "string" && (validRoles as string[]).includes(raw.role)
      ? (raw.role as UserRole)
      : null;
  return {
    id: String(raw.id),
    email: String(raw.email),
    firstName: raw.firstName,
    lastName: raw.lastName,
    name: raw.name ? String(raw.name) : combined || String(raw.email),
    isOwner: raw.isOwner === true,
    role,
    autoTrackingEnabled: raw.autoTrackingEnabled !== false,
  };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [ready, setReady] = useState(false);

  // Mirror of `user` for callbacks that need fresh state without
  // re-binding on every render (AppState listener, optimistic
  // updatePreferences rollback).
  const userRef = useRef<AuthUser | null>(null);
  useEffect(() => {
    userRef.current = user;
    // Keep the AsyncStorage mirror in lockstep with the in-memory
    // user object. The geofence background task reads this on every
    // OS Enter/Exit dispatch (services/geofencing.ts).
    if (user) void autoTrackingPref.set(user.autoTrackingEnabled);
  }, [user]);

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

  // Refresh user on every foreground transition. Mirrors the
  // useGeofenceSync.tsx AppState pattern. Single network call,
  // single-row response — keeps mobile within ~30s of server truth
  // for fields like autoTrackingEnabled that may be flipped from
  // the web app or another device.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      if (!userRef.current) return;
      void refreshUser();
    });
    return () => sub.remove();
  }, [refreshUser]);

  const updatePreferences = useCallback(
    async (input: { autoTrackingEnabled?: boolean }): Promise<void> => {
      const prev = userRef.current;
      if (!prev) return;

      // Optimistic: flip local state immediately so the toggle is
      // instant-on. The userRef mirroring effect persists the new
      // value to AsyncStorage as a side-effect of setUser.
      const optimistic: AuthUser = { ...prev, ...input };
      setUser(optimistic);

      try {
        const updated = await api.updatePreferences(input);
        const mapped = toAuthUser(normalizeUser(updated));
        if (mapped) setUser(mapped);
      } catch (err) {
        // Roll back local state. The mirroring effect will rewrite
        // AsyncStorage from the restored prev. Re-throw so the caller
        // (profile screen) can surface the toast — AuthProvider mounts
        // OUTSIDE ToastProvider so we cannot useToast() here.
        setUser(prev);
        throw err;
      }
    },
    [],
  );

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

  const signOut = useCallback(async () => {
    // Unregister push token BEFORE the session is invalidated so the
    // DELETE request still authenticates. Failure is logged inside
    // the helper and never thrown — sign-out must always proceed.
    await unregisterPushTokenWithServer();
    await api.logout().catch(() => null);
    await clearSession();
    setUser(null);
  }, []);

  // Push token capture + rotation. Two effects so they have
  // independent lifecycles:
  //
  //   1. Capture-on-login: gated on `user` becoming non-null.
  //      Requests permission (once per install via the OS), captures
  //      the Expo push token if granted, and POSTs it to the server.
  //      No-op for signed-out users so we don't prompt at cold start
  //      before the user has even logged in. Re-runs on every fresh
  //      sign-in (after a sign-out / sign-in cycle); the OS prompt
  //      doesn't reappear once granted/denied, so this is cheap.
  //
  //   2. Rotation listener: mounted for the lifetime of the
  //      provider. Expo can rotate the token at any time; when it
  //      does, we re-POST so the server's record stays fresh.
  //      Subscription is created once and torn down on unmount.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void (async () => {
      const token = await registerForPushNotificationsAsync();
      if (cancelled) return;
      if (token) await registerPushTokenWithServer(token);
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => {
    const unsub = subscribeToPushTokenRotation((token) => {
      console.log("[push] token rotated, re-registering");
      void registerPushTokenWithServer(token);
    });
    return unsub;
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
      signOut,
      requestPasswordReset,
      refreshUser,
      updatePreferences,
    }),
    [
      user,
      ready,
      signIn,
      signOut,
      requestPasswordReset,
      refreshUser,
      updatePreferences,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
