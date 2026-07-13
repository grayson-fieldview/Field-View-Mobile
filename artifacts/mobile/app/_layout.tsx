import { initSentry } from "../services/sentry";
initSentry();

import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect, useRef, useState } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { PendingEnterBanner } from "@/components/PendingEnterBanner";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { DataProvider } from "@/contexts/DataContext";
import { TimesheetProvider } from "@/contexts/TimesheetContext";
import { ToastProvider } from "@/contexts/ToastContext";
import { UploadStatusProvider } from "@/contexts/UploadStatusContext";
import { useTimesheet } from "@/contexts/TimesheetContext";
import type { BackendTimesheetEntry } from "@/services/api";
import {
  configureNotificationHandler,
  getLastNotificationResponseData,
  parseClockInReceiptData,
  parseClockOutReceiptData,
  subscribeToNotificationResponses,
} from "@/services/notifications";
import {
  registerExistingPushTokenIfGranted,
  registerPushTokenWithServer,
  subscribeToForegroundNotifications,
} from "@/services/pushNotifications";
import { startProcessor as startUploadQueueProcessor } from "@/services/uploadQueue";

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
    const inOnboardingGroup = segments[0] === "(onboarding)";

    if (!user) {
      if (!inAuthGroup) router.replace("/(auth)/login");
      setRouted(true);
      return;
    }

    // User is authenticated. Time-tracking onboarding has been
    // removed, so there is no location/notification onboarding gate
    // to wait on — route straight into the app. The inOnboardingGroup
    // check stays during the transition: existing installs may
    // cold-start on the (onboarding) route and must be moved off it.
    if (inAuthGroup || inOnboardingGroup) {
      router.replace("/(tabs)");
    }
    setRouted(true);
  }, [user, ready, segments, router]);

  // Post-auth push token capture. Runs at most ONCE per provider
  // lifetime, gated on (a) an authenticated user and (b) not
  // currently on the auth/onboarding screens. This is the sole
  // trigger now that the onboarding-completion gate is gone — without
  // it, push registration would never fire.
  // `registerExistingPushTokenIfGranted` is check-only — it never
  // prompts. If permission isn't granted we silently do nothing; the
  // profile screen's settings deep-link remains the recovery path.
  const pushRegisteredRef = useRef(false);
  useEffect(() => {
    if (!user) return;
    if (pushRegisteredRef.current) return;
    const inGate = segments[0] === "(auth)" || segments[0] === "(onboarding)";
    if (inGate) return;
    pushRegisteredRef.current = true;
    let cancelled = false;
    void (async () => {
      const token = await registerExistingPushTokenIfGranted();
      if (cancelled) return;
      if (token) await registerPushTokenWithServer(token);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, segments]);

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
type PendingDeepLink = { projectId: number };

// Generic project deep-link: a notification whose data payload
// carries a numeric `projectId` routes to /project/<id>. Intentionally
// decoupled from any clock-receipt shape — the tap bridge only needs
// the destination project.
function parseDeepLink(data: unknown): PendingDeepLink | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.projectId !== "number") return null;
  return { projectId: d.projectId };
}

/**
 * Build a synthetic BackendTimesheetEntry from a clock_out_receipt
 * push payload. ClockReceiptBanner kind="out" reads only `entry.id`,
 * `entry.projectId`, and the sibling `firedAt` field — all other
 * BackendTimesheetEntry fields are placeholders. We set `clockIn`
 * to clockOutAt because the wire payload doesn't carry the original
 * clock-in time and the banner doesn't display it. `clockOut` is
 * set to clockOutAt for correctness (the entry IS closed at this
 * point, server-side).
 */
function syntheticEntryFromPush(payload: {
  timeEntryId: number;
  projectId: number;
  clockOutAt: string;
}): BackendTimesheetEntry {
  return {
    id: payload.timeEntryId,
    projectId: payload.projectId,
    clockIn: payload.clockOutAt,
    clockOut: payload.clockOutAt,
    source: "auto_geofence",
    notes: null,
  } as unknown as BackendTimesheetEntry;
}

/**
 * Sibling of `syntheticEntryFromPush` for the dwell-time auto-clock-
 * IN path (S3x-mobile). Builds a minimal BackendTimesheetEntry from
 * a clock_in_receipt push payload. ClockReceiptBanner kind="in"
 * reads only `entry.id`, `entry.projectId`, and the sibling
 * `firedAt` field — clockOut is null by definition (the entry is
 * still open at this point, server-side).
 *
 * `entryId` is wire-typed as `string` after parser normalization
 * (server sends `timeEntryId: number`, parser casts via String()).
 * BackendTimesheetEntry's `id` field is typed `number | string`, so
 * the string is accepted directly without coercion.
 */
function syntheticEntryFromPushIn(payload: {
  entryId: string;
  projectId: number;
  clockInTime: string;
}): BackendTimesheetEntry {
  return {
    id: payload.entryId,
    projectId: payload.projectId,
    clockIn: payload.clockInTime,
    clockOut: null,
    source: "auto_geofence",
    notes: null,
  } as unknown as BackendTimesheetEntry;
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
      console.log(`[notifications] cold-launch tap project=${link.projectId}`);
      setPending(link);
    });

    // Foreground/background case: listener fires for taps that
    // happen while the JS runtime is alive. These are independent
    // events from the cold-launch path — no double-handling.
    const unsub = subscribeToNotificationResponses((data) => {
      const link = parseDeepLink(data);
      if (!link) return;
      console.log(`[notifications] tap received project=${link.projectId}`);
      setPending(link);
    });

    return () => {
      alive = false;
      unsub();
    };
  }, []);

  useEffect(() => {
    if (!pending || !ready || !user) return;
    router.push({
      pathname: "/project/[id]",
      params: { id: String(pending.projectId) },
    });
    setPending(null);
  }, [pending, ready, user, router]);

  return null;
}

/**
 * Foreground-received handler for server-pushed clock_out_receipt.
 * Distinct from NotificationDeepLinkHandler (which handles TAP
 * events): this fires when the push arrives while the JS runtime
 * is foregrounded, BEFORE any user interaction. We don't navigate
 * (intrusive), only seed `firedExit` so that:
 *   - if the user is already on /project/[id] for the matching
 *     project, the kind="out" banner appears immediately
 *   - if the user is elsewhere, the OS banner (rendered by
 *     setNotificationHandler's shouldShowBanner: true) is the
 *     foreground signal; on subsequent navigation to the project,
 *     the in-app banner is also there
 *
 * Other notification types are ignored (forward-compat for future
 * S3x receipt kinds reusing the same channel).
 */
function ForegroundPushHandler() {
  const { setFiredExit, setFiredEnter } = useTimesheet();
  useEffect(() => {
    const unsub = subscribeToForegroundNotifications((data) => {
      // Try clock_out_receipt first, then clock_in_receipt. Each
      // parser is its own type guard and returns null on shape
      // mismatch, so the order is purely a small perf detail (most
      // foreground pushes today are still exit receipts; enters are
      // newer). If neither matches, fall through silently — forward-
      // compat for future receipt types reusing the same channel.
      const out = parseClockOutReceiptData(data);
      if (out) {
        console.log(
          `[push] foreground clock_out_receipt: project ${out.projectId}, entry ${out.timeEntryId}`,
        );
        setFiredExit({
          entry: syntheticEntryFromPush({
            timeEntryId: out.timeEntryId,
            projectId: out.projectId,
            clockOutAt: out.clockOutAt,
          }),
          firedAt: out.clockOutAt,
        });
        return;
      }
      const inReceipt = parseClockInReceiptData(data);
      if (inReceipt) {
        console.log(
          `[push] foreground clock_in_receipt: project ${inReceipt.projectId}, entry ${inReceipt.entryId}`,
        );
        setFiredEnter({
          entry: syntheticEntryFromPushIn({
            entryId: inReceipt.entryId,
            projectId: inReceipt.projectId,
            clockInTime: inReceipt.clockInTime,
          }),
          firedAt: inReceipt.clockInTime,
        });
        return;
      }
    });
    return unsub;
  }, [setFiredExit, setFiredEnter]);
  return null;
}

function RootLayoutNav() {
  return (
    <Stack screenOptions={{ headerBackTitle: "Back" }}>
      <Stack.Screen name="(auth)" options={{ headerShown: false }} />
      <Stack.Screen name="(onboarding)" options={{ headerShown: false }} />
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
        name="capture"
        options={{ headerShown: false, presentation: "fullScreenModal" }}
      />
    </Stack>
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
  useEffect(() => {
    if ((fontsLoaded || fontError) && routed) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError, routed]);

  // Start the background upload queue processor once at app launch. The
  // function is idempotent so re-runs during fast-refresh are safe.
  // configureNotificationHandler is also idempotent — sets the
  // foreground-presentation policy so receipt notifications appear as
  // banners even when the app is open (S31b symmetry: same UX
  // foreground/background).
  useEffect(() => {
    startUploadQueueProcessor();
    configureNotificationHandler();
  }, []);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <GestureHandlerRootView>
            <KeyboardProvider>
              <AuthProvider>
                <DataProvider>
                  <ToastProvider>
                    <TimesheetProvider>
                      <UploadStatusProvider>
                        <AuthGate>
                          <NotificationDeepLinkHandler />
                          <ForegroundPushHandler />
                          <PendingEnterBanner />
                          <RootLayoutNav />
                        </AuthGate>
                      </UploadStatusProvider>
                    </TimesheetProvider>
                  </ToastProvider>
                </DataProvider>
              </AuthProvider>
            </KeyboardProvider>
          </GestureHandlerRootView>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
