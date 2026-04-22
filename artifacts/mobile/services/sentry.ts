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
  });
  console.log("[sentry] initialized");
}

export { Sentry };
