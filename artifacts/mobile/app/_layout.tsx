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
import {
  locationOnboardingFlags,
  useLocationPermission,
} from "@/services/permissions";
import { startProcessor as startUploadQueueProcessor } from "@/services/uploadQueue";

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient();

function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, ready } = useAuth();
  const { status: locationStatus } = useLocationPermission();
  const segments = useSegments();
  const router = useRouter();

  // `null` until we've read AsyncStorage; treated as "still loading" so we
  // don't bounce a returning user out of (tabs) for one frame on cold start.
  //
  // Build 23 follow-up: ALSO subscribe to in-process updates from
  // `locationOnboardingFlags.setPreprompted`. AsyncStorage on its
  // own doesn't notify other readers, so the onboarding screen's
  // mid-session write was invisible here — AuthGate's stale
  // `preprompted=false` triggered an immediate bounce back to
  // onboarding right after `exitToApp`'s `router.replace("/(tabs)")`,
  // which only force-quit cleared. With the subscription, the
  // listener pushes `true` synchronously when setPreprompted
  // resolves, and the next routing-effect run sees the truth.
  const [preprompted, setPreprompted] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    locationOnboardingFlags.getPreprompted().then((v) => {
      if (alive) setPreprompted(v);
    });
    const unsub = locationOnboardingFlags.subscribePreprompted((v) => {
      if (alive) setPreprompted(v);
    });
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  // `routed` flips to true the first time the routing effect runs
  // with enough data to make a decision. Children are NOT rendered
  // until then — see the gate at the return statement below.
  //
  // Build 23 follow-up (Issue 2): on cold launch, expo-router
  // mounts the default URL `/(tabs)/index` synchronously while
  // AuthGate is still waiting on `preprompted` and `locationStatus`
  // to resolve. `(tabs)/index.tsx` has a mount effect that calls
  // `Location.requestForegroundPermissionsAsync()` (`refreshUserLoc`
  // for the Nearby sort), so the iOS dialog opens BEFORE we get a
  // chance to `router.replace` to onboarding. The onboarding
  // pre-prompt screen then renders underneath the already-visible
  // dialog. Gating children on `routed` prevents (tabs)/index from
  // mounting in that limbo window — the URL is settled before any
  // screen module gets to run its mount effects.
  const [routed, setRouted] = useState(false);

  useEffect(() => {
    if (!ready) return;
    const inAuthGroup = segments[0] === "(auth)";
    const inOnboardingGroup = segments[0] === "(onboarding)";

    if (!user) {
      if (!inAuthGroup) router.replace("/(auth)/login");
      setRouted(true);
      return;
    }

    // User is authenticated. Decide between onboarding and the app.
    // Wait until both async signals have resolved.
    if (preprompted === null || locationStatus === "loading") return;

    // Skip onboarding once the user has been through it once
    // (preprompted), already on Always, or in a system-restricted state
    // where the screen has nothing actionable to offer. The in-app banner
    // handles re-engagement for the denied / undetermined-after-skip cases.
    // Build 23: closed the asymmetric-flag risk at the WRITE source.
    // `exitToApp` in app/(onboarding)/location.tsx now sets BOTH
    // @fv/onboarding/preprompted AND @fv/onboarding/locationUpgradeShown
    // idempotently on every exit path. AuthGate continues to check
    // preprompted alone (kept stable to avoid changing routing
    // semantics); the invariant is enforced at the writer instead.
    const needsOnboarding =
      !preprompted &&
      locationStatus !== "always-granted" &&
      locationStatus !== "restricted";

    if (needsOnboarding) {
      if (!inOnboardingGroup) router.replace("/(onboarding)/location");
    } else if (inAuthGroup || inOnboardingGroup) {
      router.replace("/(tabs)");
    }
    setRouted(true);
  }, [user, ready, segments, router, preprompted, locationStatus]);

  // Build 23: post-onboarding push token capture. Replaces the
  // 3-second setTimeout in AuthContext that raced the location
  // onboarding dialogs. Runs at most ONCE per provider lifetime,
  // gated on (a) authenticated user, (b) onboarding cleared
  // (preprompted), (c) not currently on the onboarding/auth
  // screens. `registerExistingPushTokenIfGranted` is check-only —
  // it never prompts. If permission isn't granted (user tapped
  // "Not now" on the notifications onboarding step) we silently
  // do nothing; receipts degrade gracefully and the profile
  // screen's settings deep-link remains the recovery path.
  const pushRegisteredRef = useRef(false);
  useEffect(() => {
    if (!user) return;
    if (preprompted !== true) return;
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
  }, [user, preprompted, segments]);

  // Children gate (see `routed` comment above). Returning null
  // here is preferable to a spinner because expo-router has not
  // yet committed the correct route — rendering a spinner would
  // still mount whatever screen the initial URL resolves to under
  // the spinner overlay, which is exactly what we're trying to
  // avoid. The window is sub-second on every launch.
  if (!routed) return null;

  return <>{children}</>;
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
  | { kind: "in"; projectId: number; entryId: string }
  | { kind: "out"; projectId: number; timeEntryId: number; clockOutAt: string };

function parseDeepLink(data: unknown): PendingDeepLink | null {
  const inReceipt = parseClockInReceiptData(data);
  if (inReceipt) {
    return {
      kind: "in",
      projectId: inReceipt.projectId,
      entryId: inReceipt.entryId,
    };
  }
  const outReceipt = parseClockOutReceiptData(data);
  if (outReceipt) {
    return {
      kind: "out",
      projectId: outReceipt.projectId,
      timeEntryId: outReceipt.timeEntryId,
      clockOutAt: outReceipt.clockOutAt,
    };
  }
  return null;
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
  const segments = useSegments();
  const { user, ready } = useAuth();
  const { setFiredExit } = useTimesheet();
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
      console.log(`[notifications] cold-launch tap kind=${link.kind}`);
      setPending(link);
    });

    // Foreground/background case: listener fires for taps that
    // happen while the JS runtime is alive. These are independent
    // events from the cold-launch path — no double-handling.
    const unsub = subscribeToNotificationResponses((data) => {
      const link = parseDeepLink(data);
      if (!link) return;
      console.log(`[notifications] tap received kind=${link.kind}`);
      setPending(link);
    });

    return () => {
      alive = false;
      unsub();
    };
  }, []);

  useEffect(() => {
    if (!pending || !ready || !user) return;
    // Drop the deep-link if the user is mid-onboarding. A
    // notification implies geofence registration succeeded (so
    // first-stage location permission is granted), but they may
    // not have completed the Always-upgrade interstitial yet.
    // Skipping that means no Always permission, so geofencing
    // works in foreground only — AND the
    // @fv/onboarding/locationUpgradeShown flag stamps on next
    // launch, permanently locking them out of the prompt. The
    // entry is already created server-side, so the user loses
    // nothing by not deep-linking; they'll see it in their
    // timesheet after onboarding completes.
    if (segments[0] === "(onboarding)") {
      console.log(
        "[notifications] tap suppressed: user mid-onboarding, dropping deep-link",
      );
      setPending(null);
      return;
    }
    if (pending.kind === "in") {
      router.push({
        pathname: "/project/[id]",
        params: {
          id: String(pending.projectId),
          recentClockIn: pending.entryId,
        },
      });
    } else {
      // Seed firedExit BEFORE navigating so the kind="out" banner
      // is visible the moment the project screen mounts.
      setFiredExit({
        entry: syntheticEntryFromPush({
          timeEntryId: pending.timeEntryId,
          projectId: pending.projectId,
          clockOutAt: pending.clockOutAt,
        }),
        firedAt: pending.clockOutAt,
      });
      router.push({
        pathname: "/project/[id]",
        params: { id: String(pending.projectId) },
      });
    }
    setPending(null);
  }, [pending, ready, user, router, segments, setFiredExit]);

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

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

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
