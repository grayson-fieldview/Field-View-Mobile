import { Platform } from "react-native";

/**
 * Meta (Facebook) app-install attribution.
 *
 * App ID / Client Token are injected at build time by the
 * "react-native-fbsdk-next" config plugin (app.json) into
 * Info.plist / AndroidManifest — never set here in JS.
 *
 * isAutoInitEnabled is `false` in app.json on purpose: the SDK must
 * NOT initialize (and must not start collecting the IDFA) before the
 * ATT prompt has resolved on iOS. This module performs that gated
 * init exactly once per cold launch:
 *   1. Resolve ATT status (iOS only; Android has no such gate).
 *   2. Configure advertiser-ID collection / auto-logging based on that
 *      status.
 *   3. Call Settings.initializeSDK() — this is the only place the SDK
 *      is initialized.
 * Even when tracking is denied, Meta's own guidance is to still call
 * setAdvertiserTrackingEnabled(false) and initialize — events still
 * flow for SKAdNetwork-based (aggregated, non-IDFA) attribution.
 */

let initPromise: Promise<void> | null = null;
let sdk: typeof import("react-native-fbsdk-next") | null = null;

async function resolveTrackingGranted(): Promise<boolean> {
  if (Platform.OS !== "ios") {
    // No ATT prompt off iOS. The Android Advertising ID is governed
    // by the AD_ID Play Services permission the native Facebook SDK
    // already declares — no separate app-level gate here.
    return true;
  }

  try {
    const {
      getTrackingPermissionsAsync,
      requestTrackingPermissionsAsync,
    } = await import("expo-tracking-transparency");
    const current = await getTrackingPermissionsAsync();
    if (current.status === "granted") return true;
    if (current.status === "denied") return false;

    // "undetermined" — show the system prompt exactly once.
    const requested = await requestTrackingPermissionsAsync();
    return requested.status === "granted";
  } catch (error) {
    console.warn("[meta] ATT status check failed — treating as denied", error);
    return false;
  }
}

async function runInit(): Promise<void> {
  if (Platform.OS === "web") return;

  try {
    const trackingGranted = await resolveTrackingGranted();
    sdk = await import("react-native-fbsdk-next");
    const { Settings } = sdk;

    Settings.setAdvertiserIDCollectionEnabled(trackingGranted);
    Settings.setAutoLogAppEventsEnabled(true);
    // iOS-only; resolves to a no-op `false` on Android.
    await Settings.setAdvertiserTrackingEnabled(trackingGranted);
    Settings.initializeSDK();

    console.log(`[meta] initialized (tracking=${trackingGranted})`);
  } catch (error) {
    console.warn("[meta] initialization failed — attribution disabled", error);
  }
}

/**
 * Idempotent, concurrency-safe init. Call once from the root layout
 * after the app is interactive; safe to call again (e.g. from a
 * retry) — subsequent calls resolve the same in-flight/completed
 * promise rather than re-prompting or re-initializing.
 */
export function initMetaAttribution(): Promise<void> {
  if (!initPromise) {
    initPromise = runInit();
  }
  return initPromise;
}

function logMetaEvent(
  eventName: string,
  params?: Record<string, string | number>,
): void {
  void initMetaAttribution().then(() => {
    try {
      if (!sdk) return;
      const { AppEventsLogger } = sdk;
      if (params) {
        AppEventsLogger.logEvent(eventName, params);
      } else {
        AppEventsLogger.logEvent(eventName);
      }
    } catch (error) {
      console.warn(`[meta] logEvent(${eventName}) failed`, error);
    }
  });
}

export type MetaRegistrationMethod = "email" | "google" | "apple";

/** Fires once, at account-creation success — same moment for every signup method (email, Google, Apple). */
export function logMetaRegistrationCompleted(
  method: MetaRegistrationMethod,
): void {
  void initMetaAttribution().then(() => {
    if (!sdk) return;
    const { AppEventsLogger } = sdk;
    logMetaEvent(AppEventsLogger.AppEvents.CompletedRegistration, {
      [AppEventsLogger.AppEventParams.RegistrationMethod]: method,
    });
  });
}

/**
 * Fires on subscription purchase success. iOS seat products have no
 * distinct trial SKU, so every iOS purchase logs as Subscribe. On
 * Android, callers pass isTrial=true when the server's accepted
 * entitlement reports a trial/trialing subscription status.
 */
export function logMetaSubscriptionPurchase(params: {
  productId: string;
  isTrial: boolean;
}): void {
  const { productId, isTrial } = params;
  void initMetaAttribution().then(() => {
    if (!sdk) return;
    const { AppEventsLogger } = sdk;
    logMetaEvent(
      isTrial
        ? AppEventsLogger.AppEvents.StartTrial
        : AppEventsLogger.AppEvents.Subscribe,
      { fb_content_id: productId },
    );
  });
}
