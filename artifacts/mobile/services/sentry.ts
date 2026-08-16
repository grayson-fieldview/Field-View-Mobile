import * as Sentry from "@sentry/react-native";

import { setUnclassifiedStrokeIdReporter } from "./annotations";

const DSN = process.env.EXPO_PUBLIC_SENTRY_DSN;

/** Whether the DSN was inlined into this bundle (never the value itself). */
export const sentryDsnPresent = Boolean(DSN);
/** True only after Sentry.init() actually ran (i.e. past the DSN gate). */
export let sentryEnabled = false;

export function initSentry() {
  // Measure whether the stroke-width heuristic's catch-all (ids matching
  // no known shape) is load-bearing — see services/annotations.ts. Wired
  // here (not in annotations.ts) so that module stays importable by
  // plain `node --test`.
  setUnclassifiedStrokeIdReporter((id, width) => {
    Sentry.addBreadcrumb({
      category: "annotations",
      level: "warning",
      message: "stroke id matched no known shape; width read as px",
      data: { id: String(id), width },
    });
  });
  if (!DSN) {
    console.warn("[sentry] EXPO_PUBLIC_SENTRY_DSN not set — Sentry disabled");
    return;
  }
  Sentry.init({
    dsn: DSN,
    environment: __DEV__ ? "development" : "production",
    // Dev (Metro/Replit preview) reporting is disabled so the
    // dashboard isn't flooded with compile-time noise. All SDK calls
    // (breadcrumbs, captureException) become safe no-ops in dev.
    enabled: !__DEV__,
    tracesSampleRate: 0.1,
    // Session tracking on so Crash Free Sessions populates.
    enableAutoSessionTracking: true,
    // Native crash handling (iOS/Android crash reporters). This is
    // the SDK default but pinned explicitly so a future SDK default
    // change can't silently disable it.
    enableNative: true,
    // Deliberately NOT enabled: session replay, profiling. Keep the
    // footprint minimal — errors, native crashes, breadcrumbs only.
    sendDefaultPii: false,
  });
  sentryEnabled = true;
  console.log("[sentry] initialized");
}

export { Sentry };
