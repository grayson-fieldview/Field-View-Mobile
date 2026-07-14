import * as Sentry from "@sentry/react-native";

const DSN = process.env.EXPO_PUBLIC_SENTRY_DSN;

export function initSentry() {
  if (!DSN) {
    console.warn("[sentry] EXPO_PUBLIC_SENTRY_DSN not set — Sentry disabled");
    return;
  }
  Sentry.init({
    dsn: DSN,
    environment: __DEV__ ? "development" : "production",
    tracesSampleRate: 0.1,
    enableAutoSessionTracking: true,
    // Native crash handling (iOS/Android crash reporters). This is
    // the SDK default but pinned explicitly so a future SDK default
    // change can't silently disable it.
    enableNative: true,
    // Deliberately NOT enabled: session replay, profiling. Keep the
    // footprint minimal — errors, native crashes, breadcrumbs only.
    sendDefaultPii: false,
  });
  console.log("[sentry] initialized");
}

export { Sentry };
