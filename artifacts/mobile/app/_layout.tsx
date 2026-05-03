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
  useEffect(() => {
    startUploadQueueProcessor();
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
