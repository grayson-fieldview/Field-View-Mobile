import Constants from "expo-constants";
import { Platform } from "react-native";

import { api } from "./api";

let Notifications: typeof import("expo-notifications") | null = null;
let notificationsAvailable = false;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Notifications = require("expo-notifications") as typeof import("expo-notifications");
  notificationsAvailable = true;
} catch (err) {
  console.log("[push] expo-notifications unavailable on this build", err);
}

let Device: typeof import("expo-device") | null = null;
let deviceAvailable = false;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Device = require("expo-device") as typeof import("expo-device");
  deviceAvailable = true;
} catch (err) {
  console.log("[push] expo-device unavailable on this build", err);
}

const ANDROID_CHANNEL_ID = "default";
let androidChannelEnsured = false;

async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  if (androidChannelEnsured) return;
  if (!notificationsAvailable || !Notifications) return;
  try {
    await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
      name: "Default",
      importance: Notifications.AndroidImportance.MAX,
      sound: "default",
      lightColor: "#f09004",
    });
    androidChannelEnsured = true;
  } catch (err) {
    console.log("[push] setNotificationChannelAsync failed:", err);
  }
}

function getEasProjectId(): string | null {
  const fromExpoConfig =
    Constants.expoConfig?.extra?.eas?.projectId ??
    (Constants.easConfig as { projectId?: string } | undefined)?.projectId ??
    null;
  return typeof fromExpoConfig === "string" && fromExpoConfig.length > 0
    ? fromExpoConfig
    : null;
}

/**
 * Permission check + request if needed, then capture and return the
 * Expo push token. Returns null on:
 *   - missing native binding (web, pre-S31b dev build)
 *   - simulator/emulator (Device.isDevice false)
 *   - permission denied
 *   - missing EAS projectId
 *   - any thrown error from getExpoPushTokenAsync
 *
 * Side-effect: ensures the Android default notification channel
 * exists on first call (no-op on iOS / repeat calls).
 */
export async function registerForPushNotificationsAsync(): Promise<
  string | null
> {
  if (!notificationsAvailable || !Notifications) return null;
  if (Platform.OS === "web") return null;

  if (deviceAvailable && Device && Device.isDevice === false) {
    console.log("[push] skipping token capture: not a physical device");
    return null;
  }

  await ensureAndroidChannel();

  try {
    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;
    if (status !== Notifications.PermissionStatus.GRANTED) {
      const next = await Notifications.requestPermissionsAsync({
        ios: {
          allowAlert: true,
          allowBadge: false,
          allowSound: true,
        },
      });
      status = next.status;
    }
    if (status !== Notifications.PermissionStatus.GRANTED) {
      console.log(`[push] permission not granted: ${status}`);
      return null;
    }
  } catch (err) {
    console.log("[push] permission check/request failed:", err);
    return null;
  }

  const projectId = getEasProjectId();
  if (!projectId) {
    console.log("[push] no EAS projectId in expoConfig.extra.eas.projectId");
    return null;
  }

  try {
    const tok = await Notifications.getExpoPushTokenAsync({ projectId });
    return tok.data;
  } catch (err) {
    console.log("[push] getExpoPushTokenAsync failed:", err);
    return null;
  }
}

/**
 * POST the captured Expo push token to the server. Errors are logged
 * but never thrown — push registration must NEVER block app start.
 */
export async function registerPushTokenWithServer(
  token: string,
): Promise<void> {
  try {
    // TEMP DIAGNOSTIC (remove after triage). SDK 54 upgrade regressed
    // server-side validation with 400 "Invalid Expo push token format".
    // Log the exact wire value so we can compare to the legacy
    // ExponentPushToken[…] shape.
    console.log(
      "[push diag] token =",
      JSON.stringify(token),
      "length:",
      token?.length,
      "type:",
      typeof token,
    );
    await api.registerPushToken(token);
    console.log("[push] token registered with server");
  } catch (err) {
    console.log("[push] registerPushToken failed:", err);
  }
}

/**
 * DELETE the stored push token on the server. Errors are logged but
 * never thrown — must NEVER block sign-out. Caller is responsible
 * for invoking BEFORE the session cookie is cleared so the request
 * still authenticates.
 */
export async function unregisterPushTokenWithServer(): Promise<void> {
  try {
    await api.unregisterPushToken();
    console.log("[push] token unregistered with server");
  } catch (err) {
    console.log("[push] unregisterPushToken failed:", err);
  }
}

/**
 * Subscribe to Expo's push-token rotation events. The callback is
 * invoked with the new token whenever Expo's infra rotates it (rare
 * but documented). No-op + no-op unsubscribe on missing native
 * binding.
 */
export function subscribeToPushTokenRotation(
  handler: (token: string) => void,
): () => void {
  if (!notificationsAvailable || !Notifications) return () => {};
  const sub = Notifications.addPushTokenListener((tok) => {
    if (typeof tok.data === "string" && tok.data.length > 0) {
      handler(tok.data);
    }
  });
  return () => sub.remove();
}

/**
 * Subscribe to foreground notification-received events. Distinct
 * from `subscribeToNotificationResponses` (which fires on TAP). This
 * fires when a push arrives while the app is foregrounded — the
 * `setNotificationHandler` policy still controls system banner
 * display, this listener gives us the data payload to drive in-app
 * UI (the kind="out" ClockReceiptBanner via firedExit).
 */
export function subscribeToForegroundNotifications(
  handler: (data: unknown) => void,
): () => void {
  if (!notificationsAvailable || !Notifications) return () => {};
  const sub = Notifications.addNotificationReceivedListener((notification) => {
    handler(notification.request.content.data);
  });
  return () => sub.remove();
}
