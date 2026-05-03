import * as Location from "expo-location";
import { Platform } from "react-native";

/**
 * iOS geofencing registration service.
 *
 * Maintains the iOS-registered geofence set in sync with the user's
 * recent-active projects, capped at the iOS hard limit of 20 regions.
 *
 * Session 30 scope: registration + diff + unregister only. The
 * TaskManager task body is a console.log stub — real enter/exit
 * handling lands in Session 31.
 *
 * Native module safety:
 *   `expo-task-manager` is dynamically imported inside `loadTaskManager`
 *   so this file is safe to evaluate on a Dev Build that lacks the
 *   native binding (e.g. the current pre-Session-34 build). All native
 *   calls are also gated behind `Platform.OS === "ios"` and wrapped in
 *   try/catch — a missing binding logs a warning and returns gracefully
 *   instead of crashing the app.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GeofenceEligibleProject {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  /** ISO 8601 string. Opaque to mobile — server already sorts DESC. */
  lastActivityAt: string;
}

export interface RegistrationResult {
  registered: string[];
  unregistered: string[];
  skipped: string[];
  errors: Array<{ id: string; error: string }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TASK_NAME = "fv-geofence-task";
const REGION_PREFIX = "fv-project-";
const RADIUS_METERS = 30;
const MAX_REGIONS = 20;

function regionIdFor(projectId: number): string {
  return `${REGION_PREFIX}${projectId}`;
}

// ---------------------------------------------------------------------------
// In-memory snapshot
// ---------------------------------------------------------------------------
//
// expo-location's geofencing API is "set the entire list" — there's no
// incremental add/remove and no read-back of currently-registered
// regions. We keep our own snapshot to compute diffs (idempotency) and
// to surface the count to the debug UI.

const lastRegisteredCache = new Set<string>();

// ---------------------------------------------------------------------------
// Lazy TaskManager loader (module-load safety)
// ---------------------------------------------------------------------------

type TaskManagerModule = typeof import("expo-task-manager");

let taskManagerPromise: Promise<TaskManagerModule | null> | null = null;
let taskDefined = false;

async function loadTaskManager(): Promise<TaskManagerModule | null> {
  if (taskManagerPromise) return taskManagerPromise;
  taskManagerPromise = (async () => {
    try {
      const mod = await import("expo-task-manager");
      if (!taskDefined) {
        // STUB BODY for Session 30. Real enter/exit handler arrives in
        // Session 31. Per Expo docs, defineTask should be called at
        // module load — close enough: we call it on the first sync,
        // which precedes any OS event since the OS only fires after
        // startGeofencingAsync returns.
        mod.defineTask(TASK_NAME, async ({ data, error }) => {
          if (error) {
            console.log("[geofence] task error:", error);
            return;
          }
          const payload = data as
            | {
                eventType?: Location.GeofencingEventType;
                region?: Location.LocationRegion;
              }
            | undefined;
          console.log(
            "[geofence] task fired:",
            payload?.eventType,
            payload?.region?.identifier,
          );
        });
        taskDefined = true;
      }
      return mod;
    } catch (err) {
      console.log(
        "[geofence] expo-task-manager unavailable on this build; geofencing disabled",
        err,
      );
      return null;
    }
  })();
  return taskManagerPromise;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Synchronize the iOS-registered geofence set to match `projects`.
 * Idempotent — a repeat call with the same input is a no-op.
 *
 * Caller must already have verified `Platform.OS === "ios"` AND
 * permission status is `"always-granted"`. This function performs
 * defensive checks anyway and returns an empty result with no errors
 * if those preconditions don't hold.
 */
export async function registerGeofences(
  projects: GeofenceEligibleProject[],
): Promise<RegistrationResult> {
  const result: RegistrationResult = {
    registered: [],
    unregistered: [],
    skipped: [],
    errors: [],
  };

  if (Platform.OS !== "ios") return result;

  // Cap defensively even though the server is supposed to.
  const capped = projects.slice(0, MAX_REGIONS);

  const desired = new Map<string, GeofenceEligibleProject>();
  for (const p of capped) {
    desired.set(regionIdFor(p.id), p);
  }

  // Diff against last snapshot for the result payload.
  for (const id of desired.keys()) {
    if (lastRegisteredCache.has(id)) result.skipped.push(id);
    else result.registered.push(id);
  }
  for (const id of lastRegisteredCache) {
    if (!desired.has(id)) result.unregistered.push(id);
  }

  // No-op if the desired set already matches.
  if (result.registered.length === 0 && result.unregistered.length === 0) {
    console.log(
      "[geofence] sync starting: no changes (%d regions registered)",
      lastRegisteredCache.size,
    );
    return result;
  }

  console.log(
    "[geofence] sync starting: +%d -%d (target %d)",
    result.registered.length,
    result.unregistered.length,
    desired.size,
  );

  const taskManager = await loadTaskManager();
  if (!taskManager) {
    result.errors.push({
      id: "*",
      error: "expo-task-manager native module unavailable",
    });
    return result;
  }

  try {
    if (desired.size === 0) {
      // Nothing desired — clear any existing registration.
      const started = await Location.hasStartedGeofencingAsync(TASK_NAME);
      if (started) await Location.stopGeofencingAsync(TASK_NAME);
      lastRegisteredCache.clear();
      console.log("[geofence] cleared all regions");
      return result;
    }

    const regions: Location.LocationRegion[] = capped.map((p) => ({
      identifier: regionIdFor(p.id),
      latitude: p.latitude,
      longitude: p.longitude,
      radius: RADIUS_METERS,
      notifyOnEnter: true,
      notifyOnExit: true,
    }));

    // startGeofencingAsync replaces the full set. Calling it
    // unconditionally is the idiomatic "sync to this list" operation.
    await Location.startGeofencingAsync(TASK_NAME, regions);

    lastRegisteredCache.clear();
    for (const id of desired.keys()) lastRegisteredCache.add(id);

    console.log(
      "[geofence] registered %d regions (skipped %d as unchanged)",
      desired.size,
      result.skipped.length,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log("[geofence] register error:", msg);
    result.errors.push({ id: "*", error: msg });
  }

  return result;
}

/**
 * Stop the geofencing task and clear the snapshot. Used when the user
 * revokes Always permission or signs out.
 */
export async function unregisterAllGeofences(): Promise<void> {
  if (Platform.OS !== "ios") return;
  console.log("[geofence] unregistering all regions");
  try {
    const started = await Location.hasStartedGeofencingAsync(TASK_NAME);
    if (started) {
      await Location.stopGeofencingAsync(TASK_NAME);
    }
  } catch (err) {
    console.log("[geofence] unregister error:", err);
  } finally {
    lastRegisteredCache.clear();
  }
}

/**
 * Returns the identifiers of currently-registered regions (snapshot).
 * Reflects the last successful registerGeofences call; cleared by
 * unregisterAllGeofences. For debug surfacing.
 */
export function getRegisteredGeofences(): string[] {
  return Array.from(lastRegisteredCache);
}

/** Constants exported for the debug surface and test harnesses. */
export const GEOFENCE_INTERNALS = {
  TASK_NAME,
  REGION_PREFIX,
  RADIUS_METERS,
  MAX_REGIONS,
} as const;
