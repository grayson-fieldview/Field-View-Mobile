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
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { DataProvider } from "@/contexts/DataContext";
import { ToastProvider } from "@/contexts/ToastContext";
import { UploadStatusProvider } from "@/contexts/UploadStatusContext";
import { cleanupLegacyBackgroundTasks } from "@/services/legacyTaskCleanup";
import {
  configureNotificationHandler,
  getLastNotificationResponseData,
  subscribeToNotificationResponses,
} from "@/services/notifications";
import {
  registerExistingPushTokenIfGranted,
  registerPushTokenWithServer,
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

    if (!user) {
      if (!inAuthGroup) router.replace("/(auth)/login");
      setRouted(true);
      return;
    }

    // User is authenticated. Time-tracking onboarding has been
    // removed, so there is no location/notification onboarding gate
    // to wait on — route straight into the app.
    if (inAuthGroup) {
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
    const inGate = segments[0] === "(auth)";
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

function RootLayoutNav() {
  return (
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
    // One-time upgrade cleanup: unregister OS-level background tasks
    // left behind by the removed geofencing/heartbeat services on
    // installs that predate the removal. Guarded by an AsyncStorage
    // flag so it runs once per install; never throws (best-effort).
    void cleanupLegacyBackgroundTasks();
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
          </GestureHandlerRootView>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
