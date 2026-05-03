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
import React, { useEffect, useState } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { DataProvider } from "@/contexts/DataContext";
import { TimesheetProvider } from "@/contexts/TimesheetContext";
import { ToastProvider } from "@/contexts/ToastContext";
import { UploadStatusProvider } from "@/contexts/UploadStatusContext";
import {
  configureNotificationHandler,
  getLastNotificationResponseData,
  parseClockInReceiptData,
  subscribeToNotificationResponses,
} from "@/services/notifications";
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
  const [preprompted, setPreprompted] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    locationOnboardingFlags.getPreprompted().then((v) => {
      if (alive) setPreprompted(v);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const inAuthGroup = segments[0] === "(auth)";
    const inOnboardingGroup = segments[0] === "(onboarding)";

    if (!user) {
      if (!inAuthGroup) router.replace("/(auth)/login");
      return;
    }

    // User is authenticated. Decide between onboarding and the app.
    // Wait until both async signals have resolved.
    if (preprompted === null || locationStatus === "loading") return;

    // Skip onboarding once the user has been through it once
    // (preprompted), already on Always, or in a system-restricted state
    // where the screen has nothing actionable to offer. The in-app banner
    // handles re-engagement for the denied / undetermined-after-skip cases.
    const needsOnboarding =
      !preprompted &&
      locationStatus !== "always-granted" &&
      locationStatus !== "restricted";

    if (needsOnboarding) {
      if (!inOnboardingGroup) router.replace("/(onboarding)/location");
    } else if (inAuthGroup || inOnboardingGroup) {
      router.replace("/(tabs)");
    }
  }, [user, ready, segments, router, preprompted, locationStatus]);

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
function NotificationDeepLinkHandler() {
  const router = useRouter();
  const { user, ready } = useAuth();
  const [pending, setPending] = useState<{
    projectId: number;
    entryId: string;
  } | null>(null);

  useEffect(() => {
    let alive = true;

    // Cold-launch case: the response that booted the app is
    // available synchronously via getLastNotificationResponseAsync
    // and is NOT replayed by the listener subscription. Consume it
    // exactly once.
    void getLastNotificationResponseData().then((data) => {
      if (!alive) return;
      const receipt = parseClockInReceiptData(data);
      if (!receipt) return;
      console.log(
        `[notifications] cold-launch tap: project ${receipt.projectId}, entry ${receipt.entryId}`,
      );
      setPending({ projectId: receipt.projectId, entryId: receipt.entryId });
    });

    // Foreground/background case: listener fires for taps that
    // happen while the JS runtime is alive. These are independent
    // events from the cold-launch path — no double-handling.
    const unsub = subscribeToNotificationResponses((data) => {
      const receipt = parseClockInReceiptData(data);
      if (!receipt) return;
      console.log(
        `[notifications] tap received: project ${receipt.projectId}, entry ${receipt.entryId}`,
      );
      setPending({ projectId: receipt.projectId, entryId: receipt.entryId });
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
      params: {
        id: String(pending.projectId),
        recentClockIn: pending.entryId,
      },
    });
    setPending(null);
  }, [pending, ready, user, router]);

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
