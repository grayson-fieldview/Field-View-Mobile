import { Platform } from "react-native";

/**
 * Notifications service.
 *
 * Wraps expo-notifications behind a defensive `require()` so the
 * absence of the native binding (e.g. running on web where the
 * package is a no-op) doesn't crash on launch.
 *
 * Public surface:
 *   - configureNotificationHandler() — call ONCE at app boot. Tells
 *     iOS to show banners + sound for foreground notifications too.
 *   - getNotificationPermission() — read-only permission check.
 *   - subscribeToNotificationResponses(...) — listen for taps on
 *     delivered notifications; hands the raw payload to the caller.
 *   - getLastNotificationResponseData() — read the cold-launch tap
 *     payload, if the app was booted by tapping a notification.
 */

export type NotificationPermissionStatus =
  | "granted"
  | "denied"
  | "undetermined";

// ---------------------------------------------------------------------------
// Module-top-level expo-notifications bootstrap
// ---------------------------------------------------------------------------
//
// `require()` inside try/catch:
//   - Native binding present → `Notifications` is the real module
//     and notificationsAvailable=true. All public functions delegate
//     to it.
//   - Native binding absent (web) → require() throws → caught →
//     notificationsAvailable stays false. Public functions
//     early-return with safe defaults so the rest of the app keeps
//     working without notifications.
//
// We do NOT call configureNotificationHandler() at module load —
// the handler must be set up exactly once from the React tree's
// boot path (app/_layout.tsx), not from an arbitrary import order
// at module-evaluation time. Module-load registration would also
// fight fast-refresh during dev.

let Notifications: typeof import("expo-notifications") | null = null;
let notificationsAvailable = false;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Notifications = require("expo-notifications") as typeof import("expo-notifications");
  notificationsAvailable = true;
} catch (err) {
  console.log(
    "[notifications] expo-notifications unavailable on this build",
    err,
  );
}

// ---------------------------------------------------------------------------
// Permission API
// ---------------------------------------------------------------------------

function mapPermissionStatus(
  status: import("expo-notifications").PermissionStatus,
): NotificationPermissionStatus {
  if (!Notifications) return "undetermined";
  if (status === Notifications.PermissionStatus.GRANTED) return "granted";
  if (status === Notifications.PermissionStatus.DENIED) return "denied";
  return "undetermined";
}

export async function getNotificationPermission(): Promise<NotificationPermissionStatus> {
  if (!notificationsAvailable || !Notifications) return "undetermined";
  if (Platform.OS === "web") return "undetermined";
  try {
    const res = await Notifications.getPermissionsAsync();
    return mapPermissionStatus(res.status);
  } catch (err) {
    console.log("[notifications] getPermissionsAsync failed:", err);
    return "undetermined";
  }
}

// ---------------------------------------------------------------------------
// Foreground presentation handler
// ---------------------------------------------------------------------------

/**
 * Configure how notifications are presented while the app is in the
 * foreground. Default iOS behavior is to suppress the banner when
 * the app is open — we override so the notification UX is identical
 * whether the user is on the app, on the home screen, or has the
 * phone locked.
 *
 * SDK 54+: `shouldShowAlert` is deprecated in favor of the explicit
 * `shouldShowBanner` (top-of-screen banner) + `shouldShowList`
 * (Notification Center entry) split. We set both.
 *
 * Idempotent — call once at app boot from app/_layout.tsx. No-op
 * if expo-notifications isn't loaded.
 */
export function configureNotificationHandler(): void {
  if (!notificationsAvailable || !Notifications) return;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

// ---------------------------------------------------------------------------
// Tap response handling
// ---------------------------------------------------------------------------

/**
 * Subscribe to notification tap events ("response received"). The
 * handler receives the raw `data` payload — caller is responsible
 * for narrowing it before use.
 *
 * No-op on web / missing native binding — returns a no-op
 * unsubscribe so the caller's useEffect cleanup is still safe to
 * call unconditionally.
 *
 * Note on cold-launch: addNotificationResponseReceivedListener does
 * NOT replay the cold-launch tap response that booted the app. Use
 * `getLastNotificationResponseData()` separately to capture that
 * case at mount time.
 */
export function subscribeToNotificationResponses(
  handler: (data: unknown) => void,
): () => void {
  if (!notificationsAvailable || !Notifications) return () => {};
  const sub = Notifications.addNotificationResponseReceivedListener(
    (response) => {
      handler(response.notification.request.content.data);
    },
  );
  return () => sub.remove();
}

/**
 * Read the cold-launch notification tap response, if any. Returns
 * the raw `data` payload from the most recent response that was
 * delivered while the app was killed/backgrounded, or null.
 *
 * Caller MUST treat this as one-shot — the same response is
 * returned by every call until a fresh tap occurs, so consumers
 * need their own "already handled" gate (typically: consume into
 * state once, then ignore subsequent reads from this function).
 */
export async function getLastNotificationResponseData(): Promise<unknown | null> {
  if (!notificationsAvailable || !Notifications) return null;
  try {
    const response = await Notifications.getLastNotificationResponseAsync();
    return response?.notification.request.content.data ?? null;
  } catch (err) {
    console.log(
      "[notifications] getLastNotificationResponseAsync failed:",
      err,
    );
    return null;
  }
}
