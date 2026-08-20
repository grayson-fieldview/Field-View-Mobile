import NetInfo from "@react-native-community/netinfo";
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
import { Alert, AppState, Platform } from "react-native";

import {
  ApiError,
  api,
  clearSession,
  debugCookieSnapshot,
  hasSession,
  loadSession,
  normalizeUser,
  onPaymentRequired,
  type BackendUser,
  type UserRole,
} from "@/services/api";
import { secureStorage } from "@/services/secureStorage";
import { signOutOfGoogle } from "@/services/socialAuth";
import {
  DEFAULT_PHOTO_ASPECT_RATIO,
  isPhotoAspectRatio,
  type PhotoAspectRatio,
} from "@/services/imageProcessing";
import {
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
  /** Account-wide default for the in-photo timestamp overlay. Absent on
   *  pre-rollout server payloads → false. */
  photoOverlayEnabled: boolean;
}

export interface AuthUser {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  name: string;
  /**
   * Account identifier for account-level analytics grouping. Absent on
   * legacy snapshots and pre-rollout auth responses.
   */
  accountId?: string;
  /** True when this user owns their account (can delete the whole account). */
  isOwner?: boolean;
  /**
   * Account role from the web backend. `null` when the server didn't
   * return a role (legacy user rows pre-Team-rework). All admin-only
   * UI must treat `null` as non-admin.
   */
  role: UserRole | null;
  /**
   * ISO-8601 timestamp of onboarding completion, or null when the
   * server says onboarding is still needed. AuthGate routes
   * null → onboarding. See toAuthUser / loadUserSnapshot for the two
   * DELIBERATELY DIFFERENT defaults when the field is missing.
   */
  profileCompletedAt: string | null;
  /**
   * Email verification flag. Optional: undefined means the server
   * response or cached snapshot predates the rollout and MUST NOT be
   * treated as unverified — AuthGate gates only on an explicit false.
   * (OAuth-created users are stamped true at row creation server-side.)
   * Named emailVerified deliberately — "verified"/"unverified" belong
   * to this file's SESSION re-verification vocabulary (authState).
   */
  emailVerified?: boolean;
  /**
   * Account billing access level from the server's
   * overlayAccountBillingOnUser (sent on every auth response).
   * Optional: undefined means the response or cached snapshot
   * predates the rollout and MUST NOT gate or restrict anything —
   * same rule as emailVerified. Only an explicit "read_only" or
   * "locked" may ever restrict.
   */
  accessLevel?: "full" | "read_only" | "locked";
  /**
   * Account billing subscription status ("trialing", "trial",
   * "active", "past_due", …). Optional: undefined means the response
   * or cached snapshot predates the rollout and MUST NOT gate —
   * same rule as emailVerified/accessLevel. Kept as a loose string
   * (matching BillingSummary.status): gates check for specific known
   * values, never branch on "not one of the known set".
   */
  subscriptionStatus?: string;
  /**
   * ISO-8601 timestamp of the persisted "Skip this step" on the
   * paywall (POST /api/account/skip-paywall, set-once). Optional, BUT
   * the rule is INVERTED relative to the other optional fields:
   * undefined means NOT skipped — the paywall may show. A missing
   * field must never permanently hide the paywall; the harmless
   * failure mode is showing it again (one tap to dismiss), not
   * hiding a gate Apple expects.
   */
  accountPaywallSkippedAt?: string;
}

interface AuthState {
  user: AuthUser | null;
  /**
   * Whether the current `user` has been confirmed by a live me() call
   * this session. "unverified" = restored from the cached snapshot
   * after an ambiguous boot-time failure (network blip, 5xx, malformed
   * response); the re-verification loop keeps retrying silently until
   * the server gives a definitive answer. UI may ignore this — an
   * unverified user is still signed in per product policy.
   */
  authState: "verified" | "unverified";
  ready: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  /**
   * Native OAuth sign-in. Takes the already-obtained identity token
   * (the native SDK calls live in the login screen layer, not here).
   * Auth state is set DIRECTLY from the POST response body — no
   * follow-up me() — because passport's req.login() rotates the
   * session id and a follow-up request can race the new Set-Cookie
   * landing in the cookie jar, producing a spurious 401.
   * On failure the ApiError (with `body.error` code) propagates
   * unchanged and existing signed-in state is left untouched.
   */
  signInWithApple: (args: {
    idToken: string;
    inviteToken?: string | null;
    firstName?: string | null;
    lastName?: string | null;
  }) => Promise<void>;
  signInWithGoogle: (args: {
    idToken: string;
    inviteToken?: string | null;
  }) => Promise<void>;
  /**
   * Email/password registration via POST /api/auth/register/mobile.
   * Same contract as the OAuth methods: sets state directly from the
   * response (no follow-up request); on failure the ApiError
   * propagates unchanged and existing auth state is untouched.
   */
  signUpWithEmail: (args: {
    email: string;
    password: string;
    termsAccepted: boolean;
    inviteToken?: string | null;
  }) => Promise<void>;
  signOut: () => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
  refreshUser: () => Promise<void>;
  /**
   * Apply the user object from a PATCH response directly to auth
   * state (no network). Used by onboarding to make completion
   * deterministic — see the implementation comment.
   */
  applyUpdatedUser: (raw: unknown) => void;
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
    accountId:
      (typeof raw.accountId === "string" && raw.accountId.length > 0) ||
      typeof raw.accountId === "number"
        ? String(raw.accountId)
        : undefined,
    email: String(raw.email),
    firstName: raw.firstName,
    lastName: raw.lastName,
    name: raw.name ? String(raw.name) : combined || String(raw.email),
    isOwner:
      typeof raw.isOwner === "boolean" ? raw.isOwner : undefined,
    role,
    // SERVER default: null OR missing ⇒ needs onboarding — mirrors
    // web's falsy check on the same field (client/src/App.tsx). This
    // deliberately differs from the cached-snapshot default in
    // loadUserSnapshot below — do NOT "unify" them: a fresh server
    // response omitting the field means the profile is incomplete,
    // while an old Keychain snapshot omitting it merely predates this
    // release.
    profileCompletedAt:
      typeof raw.profileCompletedAt === "string"
        ? raw.profileCompletedAt
        : null,
    // Pass-through: explicit boolean preserved, anything else
    // undefined (= not gated). Unlike profileCompletedAt there is NO
    // dual-default scheme here — server and snapshot both map absent
    // to undefined, so pre-rollout data can never gate.
    emailVerified:
      typeof raw.emailVerified === "boolean" ? raw.emailVerified : undefined,
    // Same pass-through rule as emailVerified: only the three known
    // strings survive; anything else (absent, null, unknown future
    // value) → undefined, which must never restrict.
    accessLevel:
      raw.accessLevel === "full" ||
      raw.accessLevel === "read_only" ||
      raw.accessLevel === "locked"
        ? raw.accessLevel
        : undefined,
    // Same pass-through rule: non-empty string survives, anything
    // else → undefined (never gates).
    subscriptionStatus:
      typeof raw.subscriptionStatus === "string" &&
      raw.subscriptionStatus.length > 0
        ? raw.subscriptionStatus
        : undefined,
    // Pass-through with the INVERTED default: non-empty string =
    // skipped, anything else (absent, null) → undefined = NOT
    // skipped, paywall may show. Absent must never hide the paywall.
    accountPaywallSkippedAt:
      typeof raw.accountPaywallSkippedAt === "string" &&
      raw.accountPaywallSkippedAt.length > 0
        ? raw.accountPaywallSkippedAt
        : undefined,
  };
}

// ---- Cached user snapshot ---------------------------------------------
// Minimal persisted copy of the last me()-confirmed user, stored in the
// Keychain alongside the session cookie. Lets a cold start that can't
// reach the server land in the app (authState "unverified") instead of
// on the login screen. Cleared on explicit sign-out and confirmed 401.

const CACHED_USER_KEY = "fv_cached_user_v1";

/**
 * Sentinel written into AuthUser.profileCompletedAt when an old
 * Keychain snapshot (pre-onboarding release) has no key at all. Any
 * non-null value means "do not route to onboarding"; the next
 * successful me() replaces it with the server's real value.
 */
const LEGACY_SNAPSHOT_PROFILE_COMPLETED = "legacy-snapshot-assumed-complete";

async function persistUserSnapshot(u: AuthUser): Promise<void> {
  try {
    await secureStorage.setItem(CACHED_USER_KEY, JSON.stringify(u));
  } catch {
    // Best-effort — a failed write only means the next ambiguous boot
    // falls back to the no-snapshot path.
  }
}

async function loadUserSnapshot(): Promise<AuthUser | null> {
  try {
    const raw = await secureStorage.getItem(CACHED_USER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AuthUser>;
    if (typeof parsed.id !== "string" || typeof parsed.email !== "string") {
      return null;
    }
    return {
      id: parsed.id,
      accountId:
        typeof parsed.accountId === "string" && parsed.accountId.length > 0
          ? parsed.accountId
          : undefined,
      email: parsed.email,
      firstName: parsed.firstName,
      lastName: parsed.lastName,
      name: typeof parsed.name === "string" ? parsed.name : parsed.email,
      isOwner:
        typeof parsed.isOwner === "boolean" ? parsed.isOwner : undefined,
      role: parsed.role ?? null,
      // SNAPSHOT default: field ABSENT ⇒ treat as COMPLETED. Older
      // snapshots (written before this release) have no
      // profileCompletedAt key; existing users booting offline from
      // cache must never get trapped in onboarding. Only an explicit
      // null (written by a post-release snapshot from a server that
      // said "incomplete") routes to onboarding. This deliberately
      // differs from the server default in toAuthUser above — do NOT
      // "unify" them.
      profileCompletedAt:
        parsed.profileCompletedAt === undefined
          ? LEGACY_SNAPSHOT_PROFILE_COMPLETED
          : parsed.profileCompletedAt,
      // Same pass-through as toAuthUser — explicit true/false
      // preserved, anything else undefined. Absent-in-snapshot is NOT
      // gated, so old snapshots can't strand an offline user on
      // verify-email.
      emailVerified:
        typeof parsed.emailVerified === "boolean"
          ? parsed.emailVerified
          : undefined,
      // Same pass-through as toAuthUser — absent-in-snapshot is
      // undefined, never restrictive, so old snapshots can't lock an
      // offline user out of writes.
      accessLevel:
        parsed.accessLevel === "full" ||
        parsed.accessLevel === "read_only" ||
        parsed.accessLevel === "locked"
          ? parsed.accessLevel
          : undefined,
      // Same pass-through as toAuthUser — absent-in-snapshot is
      // undefined, so an old snapshot can never gate an offline user
      // onto the paywall.
      subscriptionStatus:
        typeof parsed.subscriptionStatus === "string" &&
        parsed.subscriptionStatus.length > 0
          ? parsed.subscriptionStatus
          : undefined,
      // Same pass-through as toAuthUser, same INVERTED default:
      // absent-in-snapshot → undefined = not skipped. An old snapshot
      // re-showing the paywall is the harmless direction (one tap);
      // silently hiding it forever is not.
      accountPaywallSkippedAt:
        typeof parsed.accountPaywallSkippedAt === "string" &&
        parsed.accountPaywallSkippedAt.length > 0
          ? parsed.accountPaywallSkippedAt
          : undefined,
    };
  } catch {
    return null;
  }
}

async function clearUserSnapshot(): Promise<void> {
  await secureStorage.removeItem(CACHED_USER_KEY).catch(() => {});
}

function breadcrumbAuthState(
  state: "verified" | "unverified" | "signed-out",
  trigger: string,
): void {
  console.log(`[auth] authState → ${state} (${trigger})`);
  Sentry.addBreadcrumb({
    category: "auth",
    level: "info",
    message: `authState → ${state}`,
    data: { trigger },
  });
}

// ---- me() outcome classification ---------------------------------------
// PRODUCT POLICY: the user is signed out ONLY by explicit Sign Out or a
// CONFIRMED 401 from an authenticated endpoint. Everything ambiguous —
// network failure, 5xx, non-JSON, malformed 200 body, or a 401 on a
// request that never carried the session cookie — preserves the session
// and retries silently.

type MeOutcome =
  | { kind: "user"; user: AuthUser }
  | { kind: "unauthenticated" }
  | { kind: "ambiguous"; detail: string };

async function checkMe(): Promise<MeOutcome> {
  // Capture jar state BEFORE the request: a 401 on a request that went
  // out without the session cookie proves nothing about the session.
  const hadCookie = hasSession();
  let raw: BackendUser | null;
  try {
    raw = await api.me();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      if (!hadCookie) {
        return { kind: "ambiguous", detail: "401-without-cookie" };
      }
      return { kind: "unauthenticated" };
    }
    const status = e instanceof ApiError ? e.status : "n/a";
    const msg = e instanceof Error ? e.message : String(e);
    return { kind: "ambiguous", detail: `status=${status} ${msg}` };
  }
  const next = toAuthUser(normalizeUser(raw));
  if (next) return { kind: "user", user: next };
  // 200 whose body isn't a user (JSON null, {}, error-shaped object).
  // NOT a logout — a proxy/gateway can mangle a body without the
  // session being dead. Log the shape (key names only, no PII).
  const keys = raw && typeof raw === "object" ? Object.keys(raw) : [];
  Sentry.captureMessage("auth: me() 200 body failed normalizeUser", {
    level: "warning",
    extra: { bodyType: raw === null ? "null" : typeof raw, keys },
  });
  return { kind: "ambiguous", detail: "malformed-200-body" };
}

/** Re-verification backoff while authState is "unverified". */
const REVERIFY_BACKOFF_MS = [15_000, 30_000, 60_000];

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authState, setAuthState] = useState<"verified" | "unverified">(
    "verified",
  );
  const [ready, setReady] = useState(false);
  const [accountSettings, setAccountSettings] =
    useState<AccountSettings | null>(null);

  // Mirror of authState for listeners (AppState / NetInfo) that need
  // fresh values without re-binding.
  const authStateRef = useRef<"verified" | "unverified">("verified");
  useEffect(() => {
    authStateRef.current = authState;
  }, [authState]);
  // Serialize re-verification attempts (foreground + reconnect + timer
  // can race).
  const reverifyInFlightRef = useRef(false);
  // Session epoch: bumped on explicit sign-out and confirmed-401
  // sign-out. A reverify whose checkMe() was already in flight when the
  // epoch changed discards its result — otherwise a slow me() response
  // could repopulate the user right after sign-out.
  const sessionEpochRef = useRef(0);
  // captureMessage exactly once per app run the first time a boot lands
  // in "unverified" — production frequency data for the snapshot path.
  const bootUnverifiedReportedRef = useRef(false);

  // Mirror of `user` for callbacks that need fresh state without
  // re-binding on every render (AppState listener, optimistic
  // update rollback).
  const userRef = useRef<AuthUser | null>(null);
  // Same mirror for accountSettings so the optimistic-update
  // rollback in updateAccountSettings() can read fresh state without
  // capturing it through closure (and re-binding the callback on
  // every settings change).
  const accountSettingsRef = useRef<AccountSettings | null>(null);
  useEffect(() => {
    accountSettingsRef.current = accountSettings;
  }, [accountSettings]);

  // ---- 402 Payment Required subscriber (the ONE app-wide handler) ----
  // A read-only/locked account 402s on every write; a burst of failed
  // writes (e.g. upload queue flush) must produce ONE message, not N.
  // Debounce: show at most one alert per 30s window. No navigation —
  // the paywall route lands in a later gate.
  const lastPaymentAlertAtRef = useRef(0);
  useEffect(() => {
    return onPaymentRequired(({ message }) => {
      const now = Date.now();
      if (now - lastPaymentAlertAtRef.current < 30_000) return;
      lastPaymentAlertAtRef.current = now;
      Alert.alert("Account is read-only", message);
    });
  }, []);

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
        photoOverlayEnabled: raw.photoOverlayEnabled === true,
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
  }, [user]);

  /**
   * Apply a verified user: set state, mark verified, refresh the
   * persisted snapshot, and pull account settings.
   */
  const applyVerifiedUser = useCallback(
    (next: AuthUser, trigger: string) => {
      setUser(next);
      if (authStateRef.current !== "verified") {
        setAuthState("verified");
      }
      breadcrumbAuthState("verified", trigger);
      void persistUserSnapshot(next);
      void fetchAccountSettings();
    },
    [fetchAccountSettings],
  );

  /**
   * Confirmed-401 sign-out (policy-compliant). Local-only: clears the
   * cookie jar + cached snapshot and drops in-memory state. Does NOT
   * call api.logout()/push unregister — those belong to the explicit
   * signOut path, and the server already considers this session dead.
   */
  const applyConfirmed401 = useCallback(async (trigger: string) => {
    sessionEpochRef.current += 1;
    breadcrumbAuthState("signed-out", trigger);
    // TEMP DIAG (build 41): the attached breadcrumb trail carries the
    // last ~100 api responses (path/status/hadCookie) plus Set-Cookie
    // shapes — the exact sequence that preceded this logout.
    Sentry.captureMessage("confirmed-401 logout", {
      level: "warning",
      extra: { trigger },
    });
    await clearSession().catch(() => {});
    await clearUserSnapshot();
    setUser(null);
    setAuthState("verified");
    setAccountSettings(null);
  }, []);

  /**
   * Single re-verification attempt. Used by bootstrap recovery, the
   * foreground listener, the NetInfo reconnect listener, and the
   * unverified backoff timer. Policy:
   *   user     → verified, snapshot refreshed
   *   401      → signed out (confirmed, cookie was attached)
   *   ambiguous → no state change; stay unverified and keep retrying
   */
  const reverify = useCallback(
    async (trigger: string) => {
      if (reverifyInFlightRef.current) return;
      reverifyInFlightRef.current = true;
      try {
        const epoch = sessionEpochRef.current;
        const outcome = await checkMe();
        if (epoch !== sessionEpochRef.current) {
          // User signed out (or was 401-signed-out) while this check was
          // in flight — its result is stale, drop it.
          console.log(`[auth] reverify (${trigger}) discarded: epoch changed`);
          return;
        }
        if (outcome.kind === "user") {
          applyVerifiedUser(outcome.user, trigger);
        } else if (outcome.kind === "unauthenticated") {
          await applyConfirmed401(trigger);
        } else {
          console.log(
            `[auth] reverify (${trigger}) still ambiguous: ${outcome.detail}`,
          );
        }
      } finally {
        reverifyInFlightRef.current = false;
      }
    },
    [applyVerifiedUser, applyConfirmed401],
  );

  const bootstrap = useCallback(async () => {
    try {
      await loadSession();
    } catch (e) {
      // Keychain unreachable at cold start (rare but real on iOS
      // pre-unlock). Don't treat as logged out — the foreground
      // listener re-attempts once the device is in a usable state.
      // setReady so the app proceeds past splash.
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
    const outcome = await checkMe();
    if (outcome.kind === "user") {
      console.log("[boot] bootstrap outcome: verified user", outcome.user.id);
      applyVerifiedUser(outcome.user, "boot");
    } else if (outcome.kind === "unauthenticated") {
      // Confirmed 401 with the cookie attached — the session is dead.
      // Login screen (unchanged, policy-compliant). Clear the stale
      // cookie + snapshot so the next boot doesn't re-run this dance.
      console.log("[boot] bootstrap outcome: confirmed 401 → signed out");
      await applyConfirmed401("boot-401");
    } else if (hasSession()) {
      // Ambiguous failure WITH a session cookie present: per product
      // policy the user stays signed in. Restore the cached snapshot
      // and enter "unverified" — the re-verification loop takes over.
      console.log(
        `[boot] bootstrap outcome: ambiguous (${outcome.detail}) with cookie`,
      );
      const snapshot = await loadUserSnapshot();
      if (snapshot) {
        setUser(snapshot);
        setAuthState("unverified");
        breadcrumbAuthState("unverified", `boot-ambiguous:${outcome.detail}`);
        if (!bootUnverifiedReportedRef.current) {
          bootUnverifiedReportedRef.current = true;
          Sentry.captureMessage("auth: boot landed in unverified", {
            level: "info",
            extra: { detail: outcome.detail },
          });
        }
      } else {
        // Upgrade case: cookie exists but no snapshot yet (first launch
        // on this build). We have no identity to render, so the login
        // screen shows — but the session is NOT dead: mark unverified so
        // the backoff timer + NetInfo reconnect keep re-checking, and a
        // later successful me() signs the user back in automatically
        // without re-entering credentials.
        setAuthState("unverified");
        breadcrumbAuthState(
          "unverified",
          `boot-ambiguous-no-snapshot:${outcome.detail}`,
        );
        Sentry.addBreadcrumb({
          category: "auth",
          level: "warning",
          message: "boot ambiguous with cookie but no cached snapshot",
          data: { detail: outcome.detail },
        });
        console.warn(
          "[boot] ambiguous failure with cookie but no cached snapshot — retrying in background",
        );
      }
    } else {
      // Ambiguous failure with NO cookie: nothing to preserve.
      console.log(
        `[boot] bootstrap outcome: ambiguous (${outcome.detail}) without cookie → login`,
      );
    }
    setReady(true);
  }, [applyVerifiedUser, applyConfirmed401]);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  const refreshUser = useCallback(async () => {
    // Same policy as reverify: only a confirmed 401 (cookie attached)
    // signs the user out; a malformed 200 body or any transport
    // failure preserves the current user. Root cause of the TestFlight
    // Build 6 instant-logout bug — the prior `.catch(() => null)`
    // collapsed every failure mode into null and called setUser(null).
    await reverify("refresh");
  }, [reverify]);

  /**
   * Apply an updated user object returned by a PATCH response (e.g.
   * PATCH /api/auth/me from onboarding) directly to auth state.
   * PATCH /api/auth/me does not rotate the session id (only req.login
   * does), and it returns the full updated user — so the response is
   * authoritative and a follow-up me() is both unnecessary and racy
   * against the reverify in-flight lock. Fires ZERO network requests:
   * normalize via toAuthUser, setUser, mark verified, persist the
   * Keychain snapshot — same state transition as applyVerifiedUser
   * minus its fetchAccountSettings() network call.
   *
   * Sign-out protection: signOut/applyConfirmed401 bump the session
   * epoch and null the user while the PATCH is in flight; since this
   * method runs synchronously in the response continuation, a null
   * userRef at that point is exactly the epoch-changed case — refuse
   * to resurrect the user.
   */
  const applyUpdatedUser = useCallback(
    (raw: unknown): void => {
      if (userRef.current === null) {
        console.log("[auth] applyUpdatedUser skipped: signed out");
        return;
      }
      const next = toAuthUser(normalizeUser(raw as BackendUser | null));
      if (!next) {
        console.warn("[auth] applyUpdatedUser: response body not a user");
        return;
      }
      setUser(next);
      if (authStateRef.current !== "verified") {
        setAuthState("verified");
      }
      breadcrumbAuthState("verified", "patch-response");
      void persistUserSnapshot(next);
    },
    [],
  );

  // ---- IAP purchase listener (app-wide, iOS + Android) ---------------
  // Mounted here — NOT in a screen — so interrupted purchases,
  // Ask-to-Buy approvals, and unfinished/unacknowledged transactions
  // replay on next launch and still reach the server. Flow per event:
  // submit token → server 200 → finishTransaction → applyUpdatedUser
  // (iOS submits the JWS; Android submits purchaseToken + productId to
  // the /google/ endpoint via processGooglePlayPurchase).
  // On RETRYABLE failure (network/5xx/unrecognized) the transaction
  // stays unfinished (replays later); TERMINAL server rejections are
  // finished by the per-platform processor to stop the forever-replay
  // loop and are logged to Sentry without an alert (the user didn't
  // act). User-initiated flows still see case-specific copy on failure.
  useEffect(() => {
    if (Platform.OS !== "ios" && Platform.OS !== "android") return;
    let updateSub: { remove: () => void } | null = null;
    let errorSub: { remove: () => void } | null = null;
    let cancelled = false;
    (async () => {
      try {
        // Dynamic import: keeps a dev client that predates the
        // expo-iap native module from crashing at bundle evaluation.
        const iap = await import("expo-iap");
        // Per-platform processor + copy, same shape on both sides.
        const { processPurchase, describePurchaseError, isTerminalError } =
          Platform.OS === "ios"
            ? await import("@/services/appleIap").then((m) => ({
                processPurchase: m.processApplePurchase,
                describePurchaseError: m.describeApplePurchaseError,
                isTerminalError: m.isTerminalApplePurchaseError,
              }))
            : await import("@/services/googlePlay").then((m) => ({
                processPurchase: m.processGooglePlayPurchase,
                describePurchaseError: m.describeGooglePurchaseError,
                isTerminalError: m.isTerminalGooglePurchaseError,
              }));
        await iap.initConnection();
        if (cancelled) return;
        updateSub = iap.purchaseUpdatedListener((purchase) => {
          void (async () => {
            try {
              // Dedupe lives INSIDE the processor (shared with the
              // Restore flow on iOS) — null means another caller owns
              // this transaction right now.
              const me = await processPurchase(purchase);
              if (me) applyUpdatedUser(me);
            } catch (e) {
              // Terminal rejections here are replayed transactions,
              // not something the user just did — the processor
              // already finished the transaction to stop the replay
              // loop, and an alert on every launch would be noise the
              // user can't act on. Sentry only. (User-initiated
              // purchase/restore paths still alert with the
              // case-specific copy.)
              const terminal = isTerminalError(e);
              Sentry.captureException(e, {
                extra: { phase: "iap-purchase-submit", terminal },
              });
              if (terminal) return;
              Alert.alert(
                "Purchase not confirmed",
                describePurchaseError(e),
              );
            }
          })();
        });
        // Asynchronous store failures (post-sheet) arrive here, NOT
        // via requestPurchase's promise. User cancellation is a normal
        // outcome — stay silent; everything else gets surfaced.
        errorSub = iap.purchaseErrorListener((err) => {
          if (err.code === "user-cancelled") return;
          Sentry.captureMessage("iap purchase error", {
            level: "warning",
            extra: { code: err.code, productId: err.productId },
          });
          Alert.alert(
            "Purchase failed",
            err.message ||
              (Platform.OS === "android"
                ? "Google Play couldn't complete the purchase."
                : "The App Store couldn't complete the purchase."),
          );
        });
      } catch (e) {
        // Native module missing (stale dev client) or store connection
        // failed — IAP is simply unavailable this run. Never fatal.
        console.warn("[iap] init failed:", e);
      }
    })();
    return () => {
      cancelled = true;
      updateSub?.remove();
      errorSub?.remove();
      void import("expo-iap")
        .then((iap) => iap.endConnection())
        .catch(() => {});
    };
  }, [applyUpdatedUser]);

  // Re-attempt auth on every foreground transition. No user-null guard
  // anymore: when the boot check was ambiguous (user restored from
  // snapshot, or null with a cookie in the upgrade case) this is a
  // recovery path, not just a freshness refresh.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      if (!userRef.current && !hasSession()) return;
      void reverify("foreground");
    });
    return () => sub.remove();
  }, [reverify]);

  // NetInfo reconnect → immediate re-verification while unverified
  // (same offline→online edge detection as the upload queue).
  useEffect(() => {
    let lastConnected: boolean | null = null;
    const unsub = NetInfo.addEventListener((state) => {
      const connected =
        state.isConnected === true && state.isInternetReachable !== false;
      if (
        lastConnected === false &&
        connected &&
        authStateRef.current === "unverified"
      ) {
        void reverify("net-reconnect");
      }
      lastConnected = connected;
    });
    return () => unsub();
  }, [reverify]);

  // Modest backoff timer while unverified: 15s → 30s → 60s (capped).
  // Runs whether or not a snapshot user was restored (the no-snapshot
  // upgrade case has user === null but still needs recovery). Cleared
  // automatically when authState flips to "verified" (success or
  // confirmed 401 both set it back).
  useEffect(() => {
    if (authState !== "unverified") return;
    let cancelled = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      const delay =
        REVERIFY_BACKOFF_MS[
          Math.min(attempt, REVERIFY_BACKOFF_MS.length - 1)
        ] ?? 60_000;
      timer = setTimeout(() => {
        attempt += 1;
        void reverify("timer").finally(() => {
          if (!cancelled && authStateRef.current === "unverified") schedule();
        });
      }, delay);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [authState, reverify]);

  /**
   * Optimistic update for account-level settings. Targets the
   * admin-only PATCH endpoint and the separate accountSettings slice
   * rather than the per-user AuthUser. UI gates the call on
   * `user?.role === "admin"`; this
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
        // Not settable from mobile; carry the last known value through
        // the optimistic merge.
        photoOverlayEnabled: prev?.photoOverlayEnabled ?? false,
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
          // Not settable from mobile; keep the last known value rather
          // than depending on the PATCH echo carrying the field.
          photoOverlayEnabled: prev?.photoOverlayEnabled ?? false,
        });
      } catch (err) {
        // Roll back. Re-throw so the caller (settings UI) can
        // surface a toast — AuthProvider mounts outside Toast
        // Provider so we cannot useToast() here.
        setAccountSettings(prev);
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
      const next = toAuthUser(me);
      setUser(next);
      setAuthState("verified");
      // Persist the snapshot so a future cold start that can't reach
      // the server can restore this user instead of showing login.
      if (next) void persistUserSnapshot(next);
      // Pull account settings on the same login transition so
      // capture screens opened immediately after signing in see the
      // admin's configured ratio rather than the "4:3" fallback for
      // the first few seconds.
      void fetchAccountSettings();
    },
    [fetchAccountSettings],
  );

  /**
   * Shared completion for the OAuth paths. Identical to signIn's
   * success handling EXCEPT there is deliberately no me() fallback:
   * the server contract guarantees the full user object in the POST
   * response precisely so no follow-up authenticated request is
   * needed (req.login() rotates the session id; a follow-up can race
   * the new Set-Cookie landing in the jar → spurious 401). If the
   * body somehow doesn't normalize, we fail the sign-in rather than
   * fetch. State is only touched on success — a failed OAuth attempt
   * never clears an existing valid session.
   */
  const completeOAuthSignIn = useCallback(
    (loginRes: unknown) => {
      const me = normalizeUser(loginRes);
      if (!me)
        throw new Error("Sign-in succeeded but we couldn't load your account.");
      const next = toAuthUser(me);
      setUser(next);
      setAuthState("verified");
      // Persist the snapshot so a future cold start that can't reach
      // the server can restore this user instead of showing login.
      if (next) void persistUserSnapshot(next);
      // Deliberately NO fetchAccountSettings() here (unlike signIn):
      // an unawaited authenticated request immediately after
      // req.login() rotates the session id would depend on ordering
      // against the serialized jarWriteChain, which we're not willing
      // to rely on for this path. Settings populate on the next
      // natural fetch.
    },
    [],
  );

  const signInWithApple = useCallback(
    async (args: {
      idToken: string;
      inviteToken?: string | null;
      firstName?: string | null;
      lastName?: string | null;
    }) => {
      completeOAuthSignIn(await api.loginWithApple(args));
    },
    [completeOAuthSignIn],
  );

  const signInWithGoogle = useCallback(
    async (args: { idToken: string; inviteToken?: string | null }) => {
      completeOAuthSignIn(await api.loginWithGoogle(args));
    },
    [completeOAuthSignIn],
  );

  // Email/password registration. Same session-id rotation constraint
  // as the OAuth paths: the endpoint calls req.login() (rotates the
  // sid) and returns the full user precisely so NO follow-up request
  // is needed — state is set directly from the 201 body via the same
  // shared completion path. No checkMe()/me()/refreshUser(), no
  // parallel authenticated request. On failure the ApiError propagates
  // unchanged and existing auth state is untouched (completeOAuthSignIn
  // only mutates state on success).
  const signUpWithEmail = useCallback(
    async (args: {
      email: string;
      password: string;
      termsAccepted: boolean;
      inviteToken?: string | null;
    }) => {
      completeOAuthSignIn(await api.registerMobile(args));
    },
    [completeOAuthSignIn],
  );

  const signOut = useCallback(async () => {
    // Invalidate any in-flight reverify immediately so a slow me()
    // response can't repopulate the user after this sign-out.
    sessionEpochRef.current += 1;
    // Unregister push token BEFORE the session is invalidated so the
    // DELETE request still authenticates. Failure is logged inside
    // the helper and never thrown — sign-out must always proceed.
    await unregisterPushTokenWithServer();
    await api.logout().catch(() => null);
    await clearSession();
    await clearUserSnapshot();
    breadcrumbAuthState("signed-out", "explicit-sign-out");
    setUser(null);
    setAuthState("verified");
    // Drop the cached settings so user-A's account-wide ratio
    // doesn't bleed into user-B's signed-out splash. Next sign-in
    // refetches.
    setAccountSettings(null);
    // LAST and fire-and-forget: clear Google's cached account
    // selection so the next Google sign-in shows the account picker.
    // Deliberately not awaited — a hang in Google's native sign-out
    // (offline, Play Services issues) must never stall the logout
    // chain, and nothing here depends on it completing. The helper
    // swallows its own errors; the .catch is belt-and-braces.
    signOutOfGoogle().catch(() => {});
  }, []);

  // Push token rotation listener. Mounted for the lifetime of the
  // provider. Expo can rotate the token at any time; when it does,
  // we re-POST so the server's record stays fresh. Subscription is
  // created once and torn down on unmount.
  //
  // Token capture itself is handled by AuthGate calling
  // registerExistingPushTokenIfGranted once the user is
  // authenticated — it's check-only and never prompts.
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
      authState,
      ready,
      signIn,
      signInWithApple,
      signInWithGoogle,
      signUpWithEmail,
      signOut,
      requestPasswordReset,
      refreshUser,
      applyUpdatedUser,
      accountSettings,
      updateAccountSettings,
    }),
    [
      user,
      authState,
      ready,
      signIn,
      signInWithApple,
      signInWithGoogle,
      signUpWithEmail,
      signOut,
      requestPasswordReset,
      refreshUser,
      applyUpdatedUser,
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
