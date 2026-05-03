import { Platform } from "react-native";

import { storage } from "./storage";

/**
 * Notifications service.
 *
 * Wraps expo-notifications behind a defensive `require()` so the
 * absence of the native binding (e.g. running in a Dev Build that
 * predates the S31b EAS rebuild, or on web where the package is a
 * no-op) doesn't crash on launch. Mirrors the
 * `taskManagerAvailable`/`require()`-in-try-catch pattern used by
 * services/geofencing.ts — same reasoning, same shape.
 *
 * Public surface:
 *   - configureNotificationHandler() — call ONCE at app boot. Tells
 *     iOS to show banners + sound for foreground notifications too,
 *     so the receipt UX is symmetric across foreground/background.
 *   - requestNotificationPermission() — prompts user. Idempotent if
 *     already granted/denied (the OS returns the existing status
 *     without re-prompting after the first time).
 *   - getNotificationPermission() — read-only check.
 *   - fireClockInReceipt(...) — schedule an immediate local
 *     notification announcing a successful auto clock-in. Carries
 *     the `{ projectId, entryId }` payload that the deep-link tap
 *     handler in app/_layout.tsx unpacks for navigation.
 *   - notificationOnboardingFlags — AsyncStorage-backed "have we
 *     prompted for permission yet?" flag, mirrored on
 *     `locationOnboardingFlags` in services/permissions.ts.
 */

export type NotificationPermissionStatus =
  | "granted"
  | "denied"
  | "undetermined";

/**
 * Notification payload schema. Carried in
 * `Notifications.NotificationContentInput.data` so the tap handler
 * (app/_layout.tsx) can route to the right project detail screen
 * with the entry id surfaced as a query param for the undo banner.
 *
 * `type` is a discriminator — future notification types (S32 exit
 * receipts, etc.) should use a different literal so the tap handler
 * can branch cleanly without inferring intent from data shape.
 */
export interface ClockInReceiptData {
  type: "clock_in_receipt";
  projectId: number;
  /**
   * Snapshot of the project name at clock-in time. Carried in the
   * payload so the deep-link tap handler can render a sensible
   * fallback if the project was archived/deleted between the
   * receipt firing and the user tapping the notification.
   */
  projectName: string;
  entryId: string;
  clockInTime: string;
}

// ---------------------------------------------------------------------------
// Module-top-level expo-notifications bootstrap
// ---------------------------------------------------------------------------
//
// `require()` inside try/catch matches the geofencing.ts pattern:
//   - Native binding present → `Notifications` is the real module
//     and notificationsAvailable=true. All public functions delegate
//     to it.
//   - Native binding absent (pre-S31b Dev Build, web) → require()
//     throws → caught → notificationsAvailable stays false. Public
//     functions early-return with safe defaults so the rest of the
//     app keeps working without notifications.
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
    "[notifications] expo-notifications unavailable on this build; receipts disabled",
    err,
  );
}

// ---------------------------------------------------------------------------
// AsyncStorage flag — first-time permission prompt gating
// ---------------------------------------------------------------------------
//
// Mirrors locationOnboardingFlags in services/permissions.ts. Set
// once after the first geofence sync triggers a permission prompt
// (regardless of grant/deny outcome) so we don't re-prompt on every
// subsequent sync.

const NOTIFICATIONS_PROMPTED_KEY = "@fv/onboarding/notificationsPrompted";

export const notificationOnboardingFlags = {
  getPrompted: () => storage.getFlag(NOTIFICATIONS_PROMPTED_KEY),
  setPrompted: () => storage.setFlag(NOTIFICATIONS_PROMPTED_KEY, true),
};

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

/**
 * Prompt the user for notification permission. The OS only shows
 * the system dialog the first time per install; subsequent calls
 * return the existing grant/deny status without re-prompting.
 *
 * Caller is responsible for stamping
 * `notificationOnboardingFlags.setPrompted()` so we don't invoke
 * this on every geofence sync.
 */
export async function requestNotificationPermission(): Promise<NotificationPermissionStatus> {
  if (!notificationsAvailable || !Notifications) return "undetermined";
  if (Platform.OS === "web") return "undetermined";
  try {
    const res = await Notifications.requestPermissionsAsync({
      ios: {
        allowAlert: true,
        allowBadge: false,
        allowSound: true,
      },
    });
    return mapPermissionStatus(res.status);
  } catch (err) {
    console.log("[notifications] requestPermissionsAsync failed:", err);
    return "undetermined";
  }
}

// ---------------------------------------------------------------------------
// Foreground presentation handler
// ---------------------------------------------------------------------------

/**
 * Configure how notifications are presented while the app is in the
 * foreground. Default iOS behavior is to suppress the banner when
 * the app is open — we override so the receipt UX is identical
 * whether the user is on the app, on the home screen, or has the
 * phone locked. Symmetry per S31b spec.
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
// Clock-in receipt
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tap response handling
// ---------------------------------------------------------------------------

/**
 * Type-narrow an unknown notification payload into a clock-in
 * receipt. Returns null on any shape mismatch — defensive against
 * future S32+ receipt types reusing the same listener channel.
 *
 * Owned here because the payload schema is owned here. Consumers
 * (app/_layout.tsx) should NOT inline their own type-guards; route
 * any new payload narrowing through this module.
 */
export function parseClockInReceiptData(
  raw: unknown,
): ClockInReceiptData | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  if (d.type !== "clock_in_receipt") return null;
  if (
    typeof d.projectId !== "number" ||
    typeof d.projectName !== "string" ||
    typeof d.entryId !== "string" ||
    typeof d.clockInTime !== "string"
  ) {
    return null;
  }
  return {
    type: "clock_in_receipt",
    projectId: d.projectId,
    projectName: d.projectName,
    entryId: d.entryId,
    clockInTime: d.clockInTime,
  };
}

/**
 * Subscribe to notification tap events ("response received"). The
 * handler receives the raw `data` payload — caller is responsible
 * for narrowing it via `parseClockInReceiptData` (or future
 * equivalents for new receipt types).
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

/**
 * Format the clock-in time for the notification body in the user's
 * locale. US contractors (the bulk of the user base) get
 * 12-hour AM/PM with no leading zero on the hour, no seconds:
 * "3:15 PM". Locales that prefer 24h get 24h via the OS — we don't
 * force `hour12`.
 */
function formatClockInTime(date: Date): string {
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Schedule an immediate local notification announcing a successful
 * auto clock-in. Called from the geofence task body's silent-auto
 * sequence AFTER `api.clockIn()` resolves successfully — never
 * before, because a "you've been clocked in" notification with no
 * matching DB row would be a worse UX than a missed receipt.
 *
 * Body uses a middle dot (U+00B7) separator: "[Project] · 3:15 PM".
 * Title is the constant "Clocked in" so the front-load on the lock
 * screen is the action verb; project/time live in the body.
 *
 * No-op if expo-notifications isn't loaded OR the user has denied
 * permission. Permission state is checked by the OS at delivery
 * time, so we don't need to gate on it here — the OS just silently
 * drops the notification, which is the correct degradation.
 */
export async function fireClockInReceipt(
  projectName: string,
  projectId: number,
  entryId: string,
  clockInTime: Date,
): Promise<void> {
  if (!notificationsAvailable || !Notifications) {
    console.log(
      "[notifications] fireClockInReceipt skipped: notifications unavailable",
    );
    return;
  }
  const data: ClockInReceiptData = {
    type: "clock_in_receipt",
    projectId,
    projectName,
    entryId,
    clockInTime: clockInTime.toISOString(),
  };
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: "Clocked in",
        body: `${projectName} \u00B7 ${formatClockInTime(clockInTime)}`,
        data: data as unknown as Record<string, unknown>,
        sound: "default",
      },
      trigger: null,
    });
    console.log(
      `[notifications] receipt fired for ${projectName} (entry ${entryId})`,
    );
  } catch (err) {
    console.log("[notifications] scheduleNotificationAsync failed:", err);
  }
}
