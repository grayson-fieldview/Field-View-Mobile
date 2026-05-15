import * as Sentry from "@sentry/react-native";
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
  debugCookieSnapshot,
  loadSession,
  normalizeUser,
  type BackendUser,
  type UserRole,
} from "@/services/api";
import {
  DEFAULT_PHOTO_ASPECT_RATIO,
  isPhotoAspectRatio,
  type PhotoAspectRatio,
} from "@/services/imageProcessing";
import { autoTrackingPref } from "@/services/preferences";
import {
  registerForPushNotificationsAsync,
  registerPushTokenWithServer,
  subscribeToPushTokenRotation,
  unregisterPushTokenWithServer,
} from "@/services/pushNotifications";

/**
 * Account-level settings shared by every user on the team. Mirrors
 * the wire shape of `GET /api/account/settings` after narrowing the
 * server's `defaultPhotoAspectRatio: string` to the local
 * PhotoAspectRatio union. Settings are admin-managed (PATCH endpoint
 * is gated 403); every user reads them so capture.tsx can pick up
 * the right ratio.
 */
export interface AccountSettings {
  defaultPhotoAspectRatio: PhotoAspectRatio;
}

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
  /**
   * Account-level settings (admin-managed). `null` until first
   * successful fetch; capture.tsx falls back to
   * DEFAULT_PHOTO_ASPECT_RATIO ("4:3") in that window so a slow or
   * failed fetch never blocks the camera.
   */
  accountSettings: AccountSettings | null;
  /**
   * Optimistic admin-only update. Throws on PATCH failure (callers
   * surface a toast); on success, server response replaces local
   * state. Non-admins receive 403 from the server — the UI hides the
   * setter, but if it's somehow called the rejection rolls back
   * local state cleanly.
   */
  updateAccountSettings: (input: {
    defaultPhotoAspectRatio?: PhotoAspectRatio;
  }) => Promise<void>;
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
  const [accountSettings, setAccountSettings] =
    useState<AccountSettings | null>(null);

  // Mirror of `user` for callbacks that need fresh state without
  // re-binding on every render (AppState listener, optimistic
  // updatePreferences rollback).
  const userRef = useRef<AuthUser | null>(null);
  // Same mirror for accountSettings so the optimistic-update
  // rollback in updateAccountSettings() can read fresh state without
  // capturing it through closure (and re-binding the callback on
  // every settings change).
  const accountSettingsRef = useRef<AccountSettings | null>(null);
  useEffect(() => {
    accountSettingsRef.current = accountSettings;
  }, [accountSettings]);

  /**
   * Fetch + narrow account settings. On any error (including 401:
   * settings are public to authenticated users so a 401 here means
   * the session is dead; the existing me()/refreshUser machinery
   * handles the actual logout) we log to Sentry and leave local
   * state untouched. Capture defaults to "4:3" while
   * accountSettings is null.
   *
   * Narrowing: server returns `defaultPhotoAspectRatio: string`. If
   * the value isn't one of "4:3" | "1:1" | "16:9" we treat the row
   * as malformed and skip the local update — better to keep the
   * previous known-good value (or null) than persist garbage that
   * the cropper can't honor.
   */
  const fetchAccountSettings = useCallback(async (): Promise<void> => {
    try {
      const raw = await api.getAccountSettings();
      if (!isPhotoAspectRatio(raw.defaultPhotoAspectRatio)) {
        Sentry.captureException(
          new Error(
            `[auth] account settings: unknown defaultPhotoAspectRatio "${raw.defaultPhotoAspectRatio}"`,
          ),
        );
        return;
      }
      setAccountSettings({
        defaultPhotoAspectRatio: raw.defaultPhotoAspectRatio,
      });
    } catch (err) {
      // Default fallback path — capture stays at "4:3". Logged for
      // observability so we notice if this fails consistently for
      // some users (which would suggest a real backend regression
      // rather than a transient network blip).
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[auth] getAccountSettings failed:", msg);
      Sentry.captureException(err, {
        extra: { phase: "fetchAccountSettings" },
      });
    }
  }, []);
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
    } catch (e) {
      // Keychain unreachable at cold start (rare but real on iOS
      // pre-unlock). Don't treat as logged out — the foreground
      // refresh effect will re-attempt once the device is in a
      // usable state. setReady so the app proceeds past splash.
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("[auth] bootstrap loadSession failed:", msg);
      setReady(true);
      return;
    }
    // Right before me(): confirm the cookie made it from Keychain
    // → cookieJar so we can pinpoint failures between persist and
    // attach. Logged from here (not api.ts) so the trace ordering
    // shows clearly: keychain read → jar inspect → request.
    const preMeSnap = debugCookieSnapshot();
    console.log(
      `[boot] cookieJar right before me(): size=${preMeSnap.size}, ${preMeSnap.preview || "(empty)"}`,
    );
    let me: BackendUser | null = null;
    let isNetworkOrCsrfFailure = false;
    try {
      me = await api.me();
      console.log(
        "[boot] me() returned user =",
        me && typeof me === "object" && "id" in me ? String(me.id) : "null",
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        // Explicit unauthenticated response — stay on null user.
        console.log("[boot] me() threw error status=401 message=", e.message);
        me = null;
      } else {
        // Network blip / 5xx / CSRF block at launch. Mirror the
        // refreshUser hardening: don't yank the user to the login
        // screen on a flaky cold start. Leave user at its initial
        // null and let the AppState foreground listener re-attempt
        // (services will retry once connectivity returns).
        isNetworkOrCsrfFailure = true;
        const status = e instanceof ApiError ? e.status : "n/a";
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(
          `[boot] me() threw error status=${status} message=${msg}`,
        );
      }
    }
    if (!isNetworkOrCsrfFailure) {
      const next = toAuthUser(normalizeUser(me));
      console.log(
        "[boot] bootstrap outcome: setUser(",
        next ? next.id : "null",
        ")",
      );
      setUser(next);
      // Fetch account settings only when we have a real user — the
      // settings endpoint requires auth, and there's nothing to
      // load for a signed-out cold start. Fire-and-forget so it
      // doesn't extend the splash window: capture.tsx tolerates a
      // null settings object via DEFAULT_PHOTO_ASPECT_RATIO.
      if (next) void fetchAccountSettings();
    } else {
      console.log("[boot] bootstrap outcome: skipped setUser (preserve state)");
    }
    setReady(true);
  }, [fetchAccountSettings]);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  const refreshUser = useCallback(async () => {
    // Distinguish "explicitly unauthenticated" (401 → real logout)
    // from "request couldn't complete" (network blip, 5xx, CSRF
    // block, transient cookie-jar miss). Only the former should
    // clear the in-memory user; the latter must preserve state so
    // the user isn't yanked back to the login screen mid-session.
    // Root cause of the TestFlight Build 6 instant-logout bug — the
    // prior `.catch(() => null)` collapsed every failure mode into
    // null and called setUser(null).
    let me: BackendUser | null = null;
    let isNetworkOrCsrfFailure = false;
    try {
      me = await api.me();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        me = null;
      } else {
        isNetworkOrCsrfFailure = true;
        const msg = e instanceof Error ? e.message : String(e);
        console.warn("[auth] refreshUser failed (non-401):", msg);
      }
    }
    if (!isNetworkOrCsrfFailure) {
      const next = toAuthUser(normalizeUser(me));
      setUser(next);
      // Refetch account settings alongside the user object — admin
      // could have flipped defaultPhotoAspectRatio from the web app
      // or another device while we were backgrounded. Skip when the
      // refresh resolved to a signed-out user (401 → next === null):
      // the settings endpoint requires auth, so we'd just generate
      // a guaranteed 401 + Sentry noise on every foreground after
      // session expiry. Same fire-and-forget discipline as
      // bootstrap; failure leaves the existing local copy in place.
      if (next) void fetchAccountSettings();
    }
  }, [fetchAccountSettings]);

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

  /**
   * Optimistic update for account-level settings. Mirror of
   * updatePreferences but for the admin-only PATCH endpoint and the
   * separate accountSettings slice rather than the per-user
   * AuthUser. UI gates the call on `user?.role === "admin"`; this
   * helper does NOT re-check role — the server returns 403 if a
   * non-admin somehow invokes it, the catch below rolls back.
   */
  const updateAccountSettings = useCallback(
    async (input: {
      defaultPhotoAspectRatio?: PhotoAspectRatio;
    }): Promise<void> => {
      const prev = accountSettingsRef.current;
      // Optimistic merge — if prev is null (first-fetch never
      // succeeded) seed from the input keys directly. defaultPhoto
      // AspectRatio is the only field today, so this is safe; if a
      // future field lands without a corresponding seed we'd want a
      // proper default registry.
      const optimistic: AccountSettings = {
        defaultPhotoAspectRatio:
          input.defaultPhotoAspectRatio ??
          prev?.defaultPhotoAspectRatio ??
          DEFAULT_PHOTO_ASPECT_RATIO,
      };
      setAccountSettings(optimistic);

      try {
        const updated = await api.updateAccountSettings(input);
        if (!isPhotoAspectRatio(updated.defaultPhotoAspectRatio)) {
          // Server accepted the PATCH but echoed back something
          // outside the union. Treat as malformed: roll back to
          // prev so we don't poison the local cache, but DON'T
          // throw — the write itself succeeded server-side, so
          // surfacing an error to the user would be misleading.
          Sentry.captureException(
            new Error(
              `[auth] updateAccountSettings: server echoed unknown ratio "${updated.defaultPhotoAspectRatio}"`,
            ),
          );
          setAccountSettings(prev);
          return;
        }
        setAccountSettings({
          defaultPhotoAspectRatio: updated.defaultPhotoAspectRatio,
        });
      } catch (err) {
        // Roll back. Re-throw so the caller (settings UI) can
        // surface a toast — AuthProvider mounts outside Toast
        // Provider so we cannot useToast() here. Same constraint as
        // updatePreferences below.
        setAccountSettings(prev);
        throw err;
      }
    },
    [],
  );

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

  const signIn = useCallback(
    async (email: string, password: string) => {
      const emailTrim = email.trim();
      if (!emailTrim) throw new Error("Please enter your email.");
      if (!password) throw new Error("Please enter your password.");
      const loginRes = await api.login(emailTrim, password);
      // The session cookie is now set. Fetch the canonical user record.
      let me = normalizeUser(loginRes);
      if (!me) me = normalizeUser(await api.me().catch(() => null));
      if (!me)
        throw new Error("Sign-in succeeded but we couldn't load your account.");
      setUser(toAuthUser(me));
      // Pull account settings on the same login transition so
      // capture screens opened immediately after signing in see the
      // admin's configured ratio rather than the "4:3" fallback for
      // the first few seconds.
      void fetchAccountSettings();
    },
    [fetchAccountSettings],
  );

  const signOut = useCallback(async () => {
    // Unregister push token BEFORE the session is invalidated so the
    // DELETE request still authenticates. Failure is logged inside
    // the helper and never thrown — sign-out must always proceed.
    await unregisterPushTokenWithServer();
    await api.logout().catch(() => null);
    await clearSession();
    setUser(null);
    // Drop the cached settings so user-A's account-wide ratio
    // doesn't bleed into user-B's signed-out splash. Next sign-in
    // refetches.
    setAccountSettings(null);
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
    // Defer the push permission prompt by 3s post-login. The native
    // iOS prompt triggers an AppState inactive→active transition,
    // which fires the foreground refreshUser() listener below. Doing
    // that mid-login races with the just-set session cookie and (in
    // CSRF-enforce mode pre-fix) caused refreshUser to 401 and yank
    // the user. The 3s delay lets the login flow + initial nav
    // settle before iOS surfaces its modal.
    const timer = setTimeout(() => {
      void (async () => {
        const token = await registerForPushNotificationsAsync();
        if (cancelled) return;
        if (token) await registerPushTokenWithServer(token);
      })();
    }, 3000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
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
      accountSettings,
      updateAccountSettings,
    }),
    [
      user,
      ready,
      signIn,
      signOut,
      requestPasswordReset,
      refreshUser,
      updatePreferences,
      accountSettings,
      updateAccountSettings,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
