import { initSentry, Sentry } from "../services/sentry";
initSentry();

import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import {
  DarkTheme,
  DefaultTheme,
  ThemeProvider,
} from "@react-navigation/native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { AppState, useColorScheme } from "react-native";
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { DataProvider } from "@/contexts/DataContext";
import { ToastProvider } from "@/contexts/ToastContext";
import { UploadStatusProvider } from "@/contexts/UploadStatusContext";
import { hasSkippedPlanThisSession } from "@/services/appleIap";
import { cleanupLegacyBackgroundTasks } from "@/services/legacyTaskCleanup";
import {
  configureNotificationHandler,
  getLastNotificationResponseData,
  subscribeToNotificationResponses,
} from "@/services/notifications";
import {
  getPushPermissionStatus,
  registerExistingPushTokenIfGranted,
  registerForPushNotificationsAsync,
  registerPushTokenWithServer,
} from "@/services/pushNotifications";
import { startProcessor as startUploadQueueProcessor } from "@/services/uploadQueue";

// Fade is OFF by default in SDK 54 (iOS-only option), so hideAsync()
// removes the splash as a HARD CUT, revealing whatever is on screen at
// that instant. Under Fabric + react-native-screens, React's JS commit
// precedes the native screen swap by 1-2 frames, so on cold launch the
// cut can briefly expose (tabs) content before welcome's native frame
// lands — the residual Projects flash (build 51). A 250ms crossfade
// masks that window. This is deliberate cosmetic masking, NOT more
// launch-sequencing machinery — a destination-paint signal (Option B)
// was considered and rejected: its worst case is a 5s splash via the
// fallback timer, far worse than a sub-perceptual blend.
SplashScreen.setOptions({ fade: true, duration: 250 });
SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient();

function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, ready } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  // `routed` flips to true the first time the routing effect has
  // enough data to make a decision. It is NOT used to gate the
  // navigator (that was the earlier broken approach — gating
  // children unmounts the Stack and lets `router.replace` fire
  // before the navigator commits, which expo-router silently
  // drops). It IS used by `RootLayout` to hold the splash screen
  // until the redirect has been issued, so the brief default-route
  // → login/onboarding swap happens under the splash instead of
  // surfacing a Projects flash.
  //
  // Exposed via the module-level setter below so `RootLayout` can
  // subscribe without a React context plumbing pass. `AuthGate`
  // already owns the decision; this just lets the splash effect
  // observe the result.
  const [routed, setRouted] = useState(false);
  useEffect(() => {
    if (routed) setAuthGateRouted(true);
  }, [routed]);

  useEffect(() => {
    if (!ready) return;
    const inAuthGroup = segments[0] === "(auth)";
    // Hoisted so BOTH branches share one definition. The onboarding
    // screens live under (auth) but assume an authenticated user —
    // they read `user`, gate fields on isAdmin, and PATCH
    // /api/auth/me. So while welcome/login/signup/forgot correctly
    // stay put when signed out, onboarding must not: a signed-out
    // user stranded there sees the admin-only fields silently vanish
    // (isAdmin false when user is null) and submits into a 401.
    const onOnboarding =
      segments[1] === "onboarding-profile" ||
      segments[1] === "onboarding-details";
    // verify-email lives under (auth) but, like onboarding, assumes
    // an authenticated user (reads user.email, POSTs a session-
    // cookied endpoint) — so it shares onboarding's signed-out
    // carve-out below.
    const onVerifyEmail = segments[1] === "verify-email";
    // choose-plan likewise lives under (auth) but assumes an
    // authenticated user (submits purchases against the session, and
    // its Sign-out-adjacent "Skip" nudges refreshUser) — same
    // signed-out carve-out.
    const onChoosePlan = segments[1] === "choose-plan";

    if (!user) {
      // `routed` (and therefore the splash hide) waits for the
      // redirect to COMMIT, not merely be issued. Setting it on the
      // same pass that calls router.replace lifts the splash while
      // the visible route is still (tabs) — the navigation action is
      // dispatched but not yet committed/painted, so the user sees a
      // ~0.2s Projects flash before welcome's first frame (the
      // T3→T4 splash-lift-before-paint race). Instead: issue the
      // replace and bail; when the navigation commits, `segments`
      // changes, this effect re-runs, inAuthGroup is true, and
      // routed flips with welcome actually on screen. Do NOT
      // "simplify" this back to setting routed alongside the replace.
      if (!inAuthGroup || onOnboarding || onVerifyEmail || onChoosePlan) {
        router.replace("/(auth)/welcome");
        return;
      }
      setRouted(true);
      return;
    }

    // User is authenticated. Profile onboarding gate: a user whose
    // profileCompletedAt is null (fresh server response said the
    // profile is incomplete — legacy cached snapshots default to a
    // non-null sentinel, see AuthContext) lands on onboarding, not
    // (tabs). This branch remains the ONLY navigation source for the
    // gate; the onboarding screens themselves never redirect on state,
    // and the navigator is never gated/unmounted. Same commit-then-
    // flip pattern as the unauthenticated branch: issue the replace,
    // bail, and let the segments change re-run the effect so `routed`
    // (and the splash hide) waits for the redirect to COMMIT.
    const needsOnboarding = user.profileCompletedAt == null;

    if (needsOnboarding) {
      if (!onOnboarding) {
        router.replace("/(auth)/onboarding-profile");
        return;
      }
      setRouted(true);
      return;
    }

    // Email verification gate — deliberately AFTER onboarding: the
    // server only sends the verification email on the
    // profileCompletedAt null→set transition in PATCH /api/auth/me
    // (mirroring web's /welcome funnel); registration itself sends
    // nothing for self-serve signups. Gating before onboarding
    // deadlocks — the user is stranded on verify-email waiting for
    // an email that only the onboarding PATCH triggers. Gate ONLY on
    // an explicit false — undefined means the response/snapshot
    // predates the rollout (AuthUser.emailVerified is optional) and
    // must not gate. OAuth-created users are stamped true server-side
    // at row creation, so they never land here. Same commit-then-flip
    // pattern as the other branches: issue the replace, bail, let the
    // segments change re-run the effect so `routed` (and the splash
    // hide) waits for the redirect to COMMIT.
    const needsEmailVerification = user.emailVerified === false;

    if (needsEmailVerification) {
      if (!onVerifyEmail) {
        router.replace("/(auth)/verify-email");
        return;
      }
      setRouted(true);
      return;
    }

    // Paywall gate — after verification, before tabs. Only for the
    // account OWNER who is an admin (invitees — including invited
    // admins — never see it, same as web) while the account is still
    // in trial. subscriptionStatus is optional on AuthUser: undefined
    // (pre-rollout response/snapshot) must NEVER gate, so the check is
    // for the two explicit trial values, never "not active".
    // "Skip this step" sets a per-session module flag (mirrors web's
    // sessionStorage); the flag isn't reactive state, but the skip
    // handler calls refreshUser(), whose user-state update re-runs
    // this effect and falls through to tabs. Same commit-then-flip
    // pattern as the other branches.
    // accountPaywallSkippedAt is the PERSISTED skip (set-once via
    // POST /api/account/skip-paywall): any non-undefined value means
    // the paywall was skipped for good. undefined = NOT skipped — the
    // inverted default vs the other optional fields: a missing field
    // shows the paywall again (harmless), never hides it permanently.
    // The session flag stays as the immediate-effect fallback so
    // routing doesn't race the skip network call.
    const needsChoosePlan =
      user.isOwner === true &&
      user.role === "admin" &&
      (user.subscriptionStatus === "trialing" ||
        user.subscriptionStatus === "trial") &&
      user.accountPaywallSkippedAt === undefined &&
      !hasSkippedPlanThisSession();

    if (needsChoosePlan) {
      if (!onChoosePlan) {
        router.replace("/(auth)/choose-plan");
        return;
      }
      setRouted(true);
      return;
    }

    if (inAuthGroup) {
      router.replace("/(tabs)");
    }
    setRouted(true);
  }, [user, ready, segments, router]);

  // Post-auth push token capture, gated on (a) an authenticated user
  // and (b) not currently on the auth/onboarding screens. This is the
  // sole trigger now that the onboarding-completion gate is gone.
  //
  // Reinstall gap fix: the permission prompt is owned by onboarding,
  // but a reinstalling EXISTING user (profileCompletedAt already set)
  // skips onboarding entirely — so if the check-only capture returns
  // nothing AND the OS reports the permission as never-requested
  // ("undetermined"), we prompt ONCE right here. An explicit denial
  // ("denied") is respected — never re-prompted; the profile screen's
  // settings deep-link remains that recovery path.
  //
  // `pushAttemptedRef` gates the initial attempt (and the one prompt)
  // to once per provider lifetime. `pushTokenRegisteredRef` tracks
  // whether the SERVER accepted a token — the foreground-retry effect
  // below keeps trying (check-only, no prompt) until it has.
  const pushAttemptedRef = useRef(false);
  const pushTokenRegisteredRef = useRef(false);
  useEffect(() => {
    if (!user) return;
    if (pushAttemptedRef.current) return;
    const inGate = segments[0] === "(auth)";
    if (inGate) return;
    pushAttemptedRef.current = true;
    let cancelled = false;
    void (async () => {
      let token = await registerExistingPushTokenIfGranted();
      if (cancelled) return;
      if (!token) {
        const status = await getPushPermissionStatus();
        if (cancelled) return;
        if (status === "undetermined") {
          token = await registerForPushNotificationsAsync();
          if (cancelled) return;
        }
      }
      if (token) {
        pushTokenRegisteredRef.current =
          await registerPushTokenWithServer(token);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, segments]);

  // Foreground retry: the user may grant notification permission in
  // Settings (or the server POST may have failed) after the initial
  // attempt. On app-active, re-run the CHECK-ONLY capture — it never
  // prompts — until one server registration succeeds. Event-driven
  // only; no polling.
  useEffect(() => {
    if (!user) return;
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      if (!pushAttemptedRef.current) return; // initial attempt owns the first run
      if (pushTokenRegisteredRef.current) return;
      void (async () => {
        const token = await registerExistingPushTokenIfGranted();
        if (token) {
          pushTokenRegisteredRef.current =
            await registerPushTokenWithServer(token);
        }
      })();
    });
    return () => sub.remove();
  }, [user]);

  return <>{children}</>;
}

// --- Splash-hold bridge ---------------------------------------------------
// `AuthGate` decides the route; `RootLayout` owns the splash. We
// bridge them with a tiny module-level pub/sub instead of threading
// React context through every provider in the tree. `RootLayout`
// subscribes once on mount and hides the splash only when fonts +
// routing have both settled, which keeps the cold-launch redirect
// (default URL → login/onboarding) hidden under the native splash
// — no Projects flash, no white gap.
let authGateRouted = false;
const authGateRoutedListeners = new Set<(v: boolean) => void>();
function setAuthGateRouted(v: boolean): void {
  if (authGateRouted === v) return;
  authGateRouted = v;
  for (const l of authGateRoutedListeners) {
    try {
      l(v);
    } catch {
      /* ignore */
    }
  }
}
function subscribeAuthGateRouted(cb: (v: boolean) => void): () => void {
  authGateRoutedListeners.add(cb);
  return () => {
    authGateRoutedListeners.delete(cb);
  };
}

/**
 * Bridges incoming notification taps to expo-router navigation.
 *
 * Handles three event sources:
 *   1. Tap while app is foregrounded         → listener fires immediately
 *   2. Tap while app is backgrounded         → listener fires when JS
 *      runtime resumes (already alive)
 *   3. Tap that COLD-LAUNCHED the killed app → getLastNotificationResponseData()
 *      returns the response synchronously after JS boots; the listener
 *      does NOT replay it
 *
 * All three paths funnel into the same `pending` state, which is
 * consumed by an effect that waits for AuthGate to settle. We don't
 * navigate into /project/<id> until `auth.ready && auth.user`,
 * because:
 *   - On cold launch, auth is in `loading` for the first frame.
 *     Pushing immediately would either race AuthGate's
 *     router.replace("/(auth)/login") or render the project screen
 *     to an unauthenticated user.
 *   - If the user is signed out, the deep link is silently dropped.
 *     This is correct: a notification from a previous session has
 *     no security claim on the current session.
 *
 * `pending` is a one-shot — cleared after consume so subsequent auth
 * state changes don't re-fire the same navigation.
 */
type PendingDeepLink =
  | { kind: "project"; projectId: number }
  | { kind: "report"; reportId: number; projectId?: number };

// Deep-link parsing:
// - data.type "walkthrough_report_ready" with numeric `reportId`
//   routes to the in-app report screen /report/<id> (projectId is
//   forwarded when present — the screen's photo picker wants it).
// - Otherwise, any payload carrying a numeric `projectId` routes to
//   /project/<id>. Intentionally decoupled from any clock-receipt
//   shape — the tap bridge only needs the destination.
function parseDeepLink(data: unknown): PendingDeepLink | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.type === "walkthrough_report_ready" && typeof d.reportId === "number") {
    return {
      kind: "report",
      reportId: d.reportId,
      projectId: typeof d.projectId === "number" ? d.projectId : undefined,
    };
  }
  if (typeof d.projectId !== "number") return null;
  return { kind: "project", projectId: d.projectId };
}

function NotificationDeepLinkHandler() {
  const router = useRouter();
  const { user, ready } = useAuth();
  const [pending, setPending] = useState<PendingDeepLink | null>(null);

  useEffect(() => {
    let alive = true;

    // Cold-launch case: the response that booted the app is
    // available synchronously via getLastNotificationResponseAsync
    // and is NOT replayed by the listener subscription. Consume it
    // exactly once.
    void getLastNotificationResponseData().then((data) => {
      if (!alive) return;
      const link = parseDeepLink(data);
      if (!link) return;
      console.log(
        `[notifications] cold-launch tap ${
          link.kind === "report"
            ? `report=${link.reportId}`
            : `project=${link.projectId}`
        }`,
      );
      setPending(link);
    });

    // Foreground/background case: listener fires for taps that
    // happen while the JS runtime is alive. These are independent
    // events from the cold-launch path — no double-handling.
    const unsub = subscribeToNotificationResponses((data) => {
      const link = parseDeepLink(data);
      if (!link) return;
      console.log(
        `[notifications] tap received ${
          link.kind === "report"
            ? `report=${link.reportId}`
            : `project=${link.projectId}`
        }`,
      );
      setPending(link);
    });

    return () => {
      alive = false;
      unsub();
    };
  }, []);

  useEffect(() => {
    if (!pending || !ready || !user) return;
    if (pending.kind === "report") {
      router.push({
        pathname: "/report/[id]",
        params: {
          id: String(pending.reportId),
          ...(pending.projectId !== undefined
            ? { projectId: String(pending.projectId) }
            : {}),
        },
      });
    } else {
      router.push({
        pathname: "/project/[id]",
        params: { id: String(pending.projectId) },
      });
    }
    setPending(null);
  }, [pending, ready, user, router]);

  return null;
}

function RootLayoutNav() {
  // Navigation theme: without a ThemeProvider, expo-router applies the
  // light DefaultTheme unconditionally — native headers render white
  // (bg + title + chevron colors) even in dark mode while screen
  // bodies follow useColors(). Select the theme from the same source
  // useColors() reads (system scheme; app.json userInterfaceStyle is
  // "automatic") so headers track the bodies.
  const scheme = useColorScheme();
  return (
    <ThemeProvider value={scheme === "dark" ? DarkTheme : DefaultTheme}>
      <Stack screenOptions={{ headerBackTitle: "Back" }}>
      <Stack.Screen name="(auth)" options={{ headerShown: false }} />
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen
        name="project/[id]"
        options={{ title: "Project", headerBackTitle: "Back" }}
      />
      <Stack.Screen
        name="report/[id]"
        options={{ title: "Report", headerBackTitle: "Back" }}
      />
      <Stack.Screen
        name="project/new"
        options={{
          title: "New project",
          presentation: "modal",
          headerBackTitle: "Cancel",
        }}
      />
      <Stack.Screen
        name="task/[id]"
        options={{ headerShown: false }}
      />
      <Stack.Screen
        name="capture"
        options={{ headerShown: false, presentation: "fullScreenModal" }}
      />
      </Stack>
    </ThemeProvider>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  // Mirror AuthGate's `routed` flag into local state via the
  // module-level pub/sub. Seed from the module-level value in case
  // AuthGate routed before RootLayout's subscriber ran (very fast
  // sessions, hot reload).
  const [routed, setRouted] = useState<boolean>(() => authGateRouted);
  useEffect(() => {
    setRouted(authGateRouted);
    return subscribeAuthGateRouted(setRouted);
  }, []);

  // Hide the native splash only after BOTH fonts and routing have
  // settled. Without the routing gate, the splash hides on font
  // load and the user sees whatever screen the default URL maps
  // to (typically (tabs)/index = Projects) for the brief window
  // before AuthGate's `router.replace` lands — a visible "Projects
  // flash" on cold launch into login/onboarding.
  //
  // `splashHiddenRef` guards against double-hide: the normal path
  // and the fallback timer below can both reach hideAsync, and
  // calling it twice can warn/throw on some platforms.
  const splashHiddenRef = useRef(false);
  const hideSplashOnce = useCallback(() => {
    if (splashHiddenRef.current) return;
    splashHiddenRef.current = true;
    SplashScreen.hideAsync();
  }, []);
  useEffect(() => {
    if ((fontsLoaded || fontError) && routed) {
      hideSplashOnce();
    }
  }, [fontsLoaded, fontError, routed, hideSplashOnce]);

  // Fallback: `routed` now waits for AuthGate's redirect to COMMIT
  // (see AuthGate), so a dropped or never-committing navigation
  // would otherwise leave the native splash up forever. One-shot
  // safety timer: 5s after fonts settle, force-hide if the normal
  // path hasn't. Cleared on unmount and inert once the splash is
  // already hidden.
  useEffect(() => {
    if (!fontsLoaded && !fontError) return;
    const timer = setTimeout(() => {
      if (splashHiddenRef.current) return;
      console.warn(
        "[splash-fallback] SPLASH_HIDE_FALLBACK_FIRED: routing did not settle within 5s of font load — force-hiding splash",
      );
      hideSplashOnce();
    }, 5000);
    return () => clearTimeout(timer);
  }, [fontsLoaded, fontError, hideSplashOnce]);

  // Start the background upload queue processor once at app launch. The
  // function is idempotent so re-runs during fast-refresh are safe.
  // configureNotificationHandler is also idempotent — sets the
  // foreground-presentation policy so receipt notifications appear as
  // banners even when the app is open (S31b symmetry: same UX
  // foreground/background).
  useEffect(() => {
    startUploadQueueProcessor();
    configureNotificationHandler();
    // One-time upgrade cleanup: unregister OS-level background tasks
    // left behind by the removed geofencing/heartbeat services on
    // installs that predate the removal. Guarded by an AsyncStorage
    // flag so it runs once per install; never throws (best-effort).
    void cleanupLegacyBackgroundTasks();
  }, []);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      {/* Render crashes are otherwise invisible: the boundary swallows
        * them before Sentry's global handlers ever run (build 63 white
        * screen shipped with zero telemetry). */}
      <ErrorBoundary
        onError={(error, componentStack) => {
          try {
            Sentry.captureException(error, {
              tags: { source: "error_boundary" },
              contexts: { react: { componentStack } },
            });
          } catch {
            // Sentry must never mask the original error.
          }
        }}
      >
        <QueryClientProvider client={queryClient}>
          <GestureHandlerRootView>
            {/* Bottom-sheet modals (photo viewer sheets, assignee picker)
                present through this provider. Render-only for screens
                that never call useBottomSheetModal — no behavior change
                elsewhere. Must sit inside GestureHandlerRootView. */}
            <BottomSheetModalProvider>
            <KeyboardProvider>
              <AuthProvider>
                <DataProvider>
                  <ToastProvider>
                    <UploadStatusProvider>
                      <AuthGate>
                        <NotificationDeepLinkHandler />
                        <RootLayoutNav />
                      </AuthGate>
                    </UploadStatusProvider>
                  </ToastProvider>
                </DataProvider>
              </AuthProvider>
            </KeyboardProvider>
            </BottomSheetModalProvider>
          </GestureHandlerRootView>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
