import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import { Platform } from "react-native";

import { api } from "./api";

// ---------------------------------------------------------------------------
// Heartbeat — server-side exit detection backup (BUILD 12, Option A)
// ---------------------------------------------------------------------------
//
// While the user has an active timesheet, stream periodic location
// updates to POST /api/heartbeat. The server compares each fix
// against the active project's coordinates and decides whether to
// fire a clock-out. Mobile is a dumb relay — no local distance
// calculation, no decision logic.
//
// Lifecycle owner: TimesheetContext (see provider's transition
// effect on `active`). Heartbeat starts when active goes null →
// not-null and stops on the inverse. Manual + auto + cancellation
// paths all converge on `setActive(null)`, so a single pair of
// start/stop calls covers every exit.
//
// Why TaskManager + startLocationUpdatesAsync (not setInterval):
// `setInterval` is suspended when the JS runtime backgrounds.
// Background location updates dispatch via the OS task queue and
// keep firing while backgrounded — which is exactly the failure
// mode we're papering over (user drives away with the app
// backgrounded, geofence exit doesn't fire, max-shift safety net
// is too coarse). The two-detector design (iOS region monitoring
// PRIMARY + heartbeat BACKUP) is robust to either path failing in
// isolation.
//
// Module-top defineTask: required for headless cold-launch. If
// the OS dispatches into the task before any React tree mounts
// (rare for heartbeat — the lifecycle requires an active session
// which requires a mounted app — but possible if the app was
// killed mid-shift), the task body must be registered at JS
// evaluation time. Same pattern as services/geofencing.ts.
//
// Cross-platform: unlike geofencing.ts (iOS-only — Android has
// no equivalent region monitoring API in expo-location), heartbeat
// runs on BOTH iOS and Android. On Android it is the ONLY
// auto-clock-out detection path; on iOS it is the backup behind
// region monitoring. Either way the server is the decider.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEARTBEAT_TASK_NAME = "fv-heartbeat-task";

// Tunables. See spec for rationale on the specific values:
//   - 50m distance interval = "meaningful movement" gate; below
//     this is GPS noise.
//   - 3min minimum cadence = battery floor; the server's exit
//     decision tolerates this latency well within the max-shift
//     safety net's bound.
const DISTANCE_INTERVAL_M = 50;
const TIME_INTERVAL_MS = 3 * 60 * 1000;

// ---------------------------------------------------------------------------
// Persisted gate — survives process restart, gates against stale stops
// ---------------------------------------------------------------------------
//
// The heartbeat task body must answer "should I POST this fix?" in
// two adversarial scenarios:
//
//   (a) Stale post-stop delivery — iOS occasionally dispatches one
//       final location update AFTER stopLocationUpdatesAsync
//       resolves (the OS had the fix queued before the stop
//       request reached the location subsystem). Without a gate,
//       that fix would POST after the user clocked out, server
//       would compute distance against a stale "active project",
//       and could fire a spurious decision.
//
//   (b) Headless cold-launch — the OS may relaunch the killed app
//       process directly into the task body when a registered
//       background location update arrives. In that case
//       runHeartbeatTaskBody runs BEFORE any React mount and
//       BEFORE startHeartbeat() runs in this fresh process. A
//       process-volatile flag defaults to "off" here and would
//       silently drop the headless heartbeat — defeating the
//       primary value-add of background location updates over
//       setInterval.
//
// Solution: persist a marker to AsyncStorage. startHeartbeat()
// writes it, stopHeartbeat() deletes it. Task body reads it on
// every dispatch. (a) After stop, key is absent → suppress. (b)
// On cold-launch, key is still set from the prior process's
// startHeartbeat → POST. AsyncStorage read is ~1ms and happens
// at most once per 3 min, so cost is negligible.
//
// v1 suffix reserves room for shape migrations; matches the
// LAST_SEEN_KEY / pendingExits / pendingEnters convention.
const HEARTBEAT_ACTIVE_KEY = "@fv/heartbeat_active_v1";

async function isHeartbeatGateOpen(): Promise<boolean> {
  try {
    const v = await AsyncStorage.getItem(HEARTBEAT_ACTIVE_KEY);
    return v !== null;
  } catch (err) {
    // Storage failure is rare. Fail OPEN: it's better to send a
    // possibly-redundant heartbeat (server idempotently no-ops on
    // closed sessions) than to silently drop a real one. Logged
    // for diagnosis.
    console.log("[heartbeat] gate read failed; failing open:", err);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Module-top TaskManager bootstrap
// ---------------------------------------------------------------------------

let TaskManager: typeof import("expo-task-manager") | null = null;
let taskManagerAvailable = false;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  TaskManager = require("expo-task-manager") as typeof import("expo-task-manager");
  taskManagerAvailable = true;
} catch (err) {
  console.log(
    "[heartbeat] expo-task-manager unavailable on this build; heartbeat disabled",
    err,
  );
}

interface HeartbeatTaskData {
  locations?: Location.LocationObject[];
}

async function runHeartbeatTaskBody({
  data,
  error,
}: {
  data: unknown;
  error: unknown;
}): Promise<void> {
  if (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log("[heartbeat] task error:", msg);
    return;
  }
  const gateOpen = await isHeartbeatGateOpen();
  if (!gateOpen) {
    // Stale post-stop delivery (see HEARTBEAT_ACTIVE_KEY comment).
    console.log("[heartbeat] suppressed: gate closed");
    return;
  }
  const payload = data as HeartbeatTaskData | null;
  const locations = payload?.locations;
  if (!locations || locations.length === 0) return;

  // OS may batch multiple fixes into a single dispatch; only POST
  // the freshest. Older fixes in the batch are wasted bandwidth
  // and the server's decision is monotonic in time anyway.
  const latest = locations[locations.length - 1];
  const { latitude, longitude } = latest.coords;
  try {
    await api.postHeartbeat({
      lat: latitude,
      lng: longitude,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    // Per spec: silent retry on next location update. No queueing.
    // Server max-shift safety net catches anything missed. 401 is
    // recoverable (session expires mid-shift; app re-auths on next
    // foreground) and intentionally NOT Sentry-captured — would
    // spam during long offline windows.
    const msg = err instanceof Error ? err.message : String(err);
    console.log("[heartbeat] POST failed (will retry on next fix):", msg);
  }
}

if (taskManagerAvailable && TaskManager) {
  TaskManager.defineTask(HEARTBEAT_TASK_NAME, runHeartbeatTaskBody);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the heartbeat location-updates task. Idempotent — calling
 * while already started is a no-op. Caller (TimesheetContext)
 * invokes this when `active` transitions null → not-null.
 *
 * Requires background location permission for full effectiveness;
 * with foreground-only permission the OS will only deliver updates
 * while the app is foregrounded (heartbeat degrades to "while-in-
 * use" mode, but doesn't fail). The dwell-permission request flow
 * lives in onboarding/permissions and is out of scope here.
 */
export async function startHeartbeat(): Promise<void> {
  if (!taskManagerAvailable) {
    console.log("[heartbeat] start skipped: TaskManager unavailable");
    return;
  }
  if (Platform.OS === "web") return;
  if (Platform.OS === "ios") {
    // Build 21: iOS background-location mode removed from app.json.
    // Region monitoring (services/geofencing.ts) does not require
    // UIBackgroundModes=["location"] and remains the PRIMARY auto-
    // clock detector. The continuous-updates heartbeat does require
    // the background mode and would throw "Background Location has
    // not been configured" if invoked. Android still runs heartbeat
    // (it's the only auto-exit detector there — geofencing is iOS-
    // only). Mirror of the Platform.OS guard in geofencing.ts.
    console.log("[heartbeat] start skipped: iOS (background mode disabled)");
    return;
  }
  try {
    // Open the persisted gate FIRST. If the OS dispatches the
    // task body between this write and startLocationUpdatesAsync
    // resolving, the body's gate check will read "open" and POST
    // correctly. Inverse race in stopHeartbeat — close gate first.
    await AsyncStorage.setItem(HEARTBEAT_ACTIVE_KEY, "1");
    const started =
      await Location.hasStartedLocationUpdatesAsync(HEARTBEAT_TASK_NAME);
    if (started) {
      // Idempotent: already running with the OS. Gate is now
      // (re-)opened; nothing else to do.
      console.log("[heartbeat] start: already running");
      return;
    }
    await Location.startLocationUpdatesAsync(HEARTBEAT_TASK_NAME, {
      accuracy: Location.Accuracy.Balanced,
      distanceInterval: DISTANCE_INTERVAL_M,
      timeInterval: TIME_INTERVAL_MS,
      // iOS privacy: shows the blue "in use" indicator while the
      // app is backgrounded so the user knows location is being
      // sampled. Required by App Store review.
      showsBackgroundLocationIndicator: true,
      // Android: persistent foreground-service notification while
      // the task runs. Required — without this, Android kills the
      // task on background. User-visible, intentional ("you are
      // being tracked while clocked in").
      foregroundService: {
        notificationTitle: "Field View — clocked in",
        notificationBody:
          "Tracking location to detect when you leave the site.",
        notificationColor: "#f09004",
      },
      // Defer to OS heuristics for pause/resume (e.g., user
      // stationary for long periods). The server's max-shift
      // safety net guards against missed-exit edge cases.
      pausesUpdatesAutomatically: false,
    });
    console.log("[heartbeat] started");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log("[heartbeat] start failed:", msg);
    // If startLocationUpdatesAsync threw, the OS-level task isn't
    // running but the gate is open. Reverse the gate so a future
    // stale dispatch (or the next start retry) doesn't see a
    // misleading "open" state.
    try {
      await AsyncStorage.removeItem(HEARTBEAT_ACTIVE_KEY);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Stop the heartbeat location-updates task. Idempotent — calling
 * while not started is a no-op. Caller invokes this when `active`
 * transitions to null OR changes to a different entry id (defensive;
 * clock-out → clock-in normally flows through null between them).
 *
 * Closes the persisted gate BEFORE the OS stop request so any
 * already-queued final dispatch is suppressed by the task body's
 * guard. See HEARTBEAT_ACTIVE_KEY rationale above.
 */
export async function stopHeartbeat(): Promise<void> {
  if (!taskManagerAvailable) return;
  if (Platform.OS === "web") return;
  if (Platform.OS === "ios") {
    // Build 21: symmetric with startHeartbeat. Nothing was ever
    // started, so there's nothing to stop. Skip the gate clear too —
    // startHeartbeat never opens it on iOS.
    return;
  }
  // Close the persisted gate FIRST. If the OS has a fix queued
  // for delivery between this point and stopLocationUpdatesAsync
  // resolving, the task body's gate check reads "closed" and
  // drops it. Also covers headless cold-launch dispatch arriving
  // after the user has clocked out across a process restart.
  try {
    await AsyncStorage.removeItem(HEARTBEAT_ACTIVE_KEY);
  } catch (err) {
    // Best-effort. If this fails, a stale dispatch could still
    // POST one heartbeat — server treats post-clock-out heartbeats
    // as no-ops, so consequences are bounded.
    console.log("[heartbeat] gate close failed:", err);
  }
  try {
    const started =
      await Location.hasStartedLocationUpdatesAsync(HEARTBEAT_TASK_NAME);
    if (!started) {
      console.log("[heartbeat] stop: not running");
      return;
    }
    await Location.stopLocationUpdatesAsync(HEARTBEAT_TASK_NAME);
    console.log("[heartbeat] stopped");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log("[heartbeat] stop failed:", msg);
  }
}

/** Constants exported for the debug surface and test harnesses. */
export const HEARTBEAT_INTERNALS = {
  HEARTBEAT_TASK_NAME,
  DISTANCE_INTERVAL_M,
  TIME_INTERVAL_MS,
} as const;
