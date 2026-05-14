import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import { AppState, Platform } from "react-native";

import { api, ApiError } from "./api";
import { fireClockInReceipt } from "./notifications";
import {
  findPendingExitsForRegion,
  removePendingExitByCompoundKey,
  removePendingExitById,
  upsertPendingExit,
} from "./pendingExits";
import { autoTrackingPref } from "./preferences";
import { Sentry } from "./sentry";

/**
 * iOS geofencing registration service.
 *
 * Maintains the iOS-registered geofence set in sync with the user's
 * recent-active projects, capped at the iOS hard limit of 20 regions.
 *
 * Session 31b scope: registration + real enter event handler with the
 * filter chain (proximity, GPS uncertainty, per-region debounce,
 * already-clocked-in suppression) followed by SILENT-AUTO clock-in
 * (no user confirmation) → notification receipt with deep-link to
 * the project detail screen for undo.
 *
 * Session 32a-mobile scope: Exit event handler with its own filter
 * chain (active-session, project-match, source==="auto_geofence",
 * already-pending, GPS uncertainty) followed by POST
 * /api/geofence/exit-detected → server creates a pending row and
 * fires the auto-clock-out 5min later. Re-enter inside the window
 * cancels the pending row server-side (cancel-pending-exit hook
 * runs as first step of handleGeofenceEnter). The persisted local
 * mirror lives in services/pendingExits.ts and is consumed by
 * TimesheetContext for post-facto receipt discovery on foreground.
 *
 * Native module safety:
 *   `expo-task-manager` is loaded via synchronous `require()` inside a
 *   try/catch at module top so `defineTask` runs at JS module-evaluation
 *   time (required for iOS to invoke the task on cold-launch from a
 *   background geofence event — see comment block below). On a Dev
 *   Build that lacks the native binding (e.g. the pre-S30.5 build),
 *   the require throws, is caught, `taskManagerAvailable` stays false,
 *   and `registerGeofences` early-returns with an error entry — the
 *   app never crashes.
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
// Bumped from "fv-project-" → "fv-project-v2-" alongside the
// RADIUS_METERS bump (100 → 150) below. iOS bakes the radius into a
// region at registration time, and registerGeofences diffs by full
// region identifier — so without changing the prefix, existing
// TestFlight users would see the new constant but keep firing on
// the old 100m regions until they sign out + back in. The prefix
// bump makes every new region identifier disjoint from the cached
// v1 set, which forces Location.startGeofencingAsync to replace the
// full OS-side registration with new 150m regions on next sync.
const REGION_PREFIX = "fv-project-v2-";
// Comfortably above Apple's 100m reliability floor for region
// monitoring; tighter radii produce flaky enter/exit events at the
// GPS accuracy floor. Downstream proximity filter
// (PROXIMITY_THRESHOLD_M=200m) still gates actual clock-in, so this
// value mainly controls how early the OS dispatches us.
const RADIUS_METERS = 150;
const MAX_REGIONS = 20;
// Bumped suffix invalidates the persisted snapshot when we change
// either the serialized shape OR the meaning of the data inside —
// the v1→v2 bump here pairs with the REGION_PREFIX bump above so
// that on first launch after update, the old v1-prefixed cache is
// discarded rather than rehydrated alongside the new v2 desired
// set. Strictly belt-and-braces (the prefix bump alone forces a
// full re-registration), but keeps storage state internally
// consistent.
const REGISTERED_CACHE_STORAGE_KEY = "fv.geofence.registered-cache.v2";
// Hard ceiling on the rehydration await inside the task body. AsyncStorage
// reads on iOS are typically <50ms; 3s is generous enough to absorb a cold
// disk + worst-case Keychain contention without leaving the OS-dispatched
// task hanging long enough to be killed.
const REHYDRATE_TIMEOUT_MS = 3_000;

// Filter-chain thresholds. See docstring on the task body below for
// rationale on each. Tunable based on field reports.
const PROXIMITY_THRESHOLD_M = 200;
const GPS_ACCURACY_THRESHOLD_M = 200;
const DEBOUNCE_MS = 5 * 60 * 1000;

function regionIdFor(projectId: number): string {
  return `${REGION_PREFIX}${projectId}`;
}

/** Inverse of regionIdFor. Returns null on malformed identifiers. */
function parseProjectId(regionId: string): number | null {
  if (!regionId.startsWith(REGION_PREFIX)) return null;
  const raw = regionId.slice(REGION_PREFIX.length);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Great-circle distance in meters between two lat/lng points. */
function haversineMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const R = 6_371_000; // Earth radius, meters
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------------------------------------------------------------------------
// In-memory snapshot
// ---------------------------------------------------------------------------
//
// expo-location's geofencing API is "set the entire list" — there's no
// incremental add/remove and no read-back of currently-registered
// regions. We keep our own snapshot to compute diffs (idempotency), to
// surface the count to the debug UI, AND to give the headless task
// body access to project name + lat/lng without a network round-trip
// (the task fires from iOS without React state available).
//
// The cache is `Map<regionId, project>` rather than a Set so the task
// body can look up the full project record by region identifier in O(1).

const lastRegisteredCache = new Map<string, GeofenceEligibleProject>();

// ---------------------------------------------------------------------------
// Persistence: cache snapshot ↔ AsyncStorage
// ---------------------------------------------------------------------------
//
// The in-memory `lastRegisteredCache` only survives as long as the JS
// runtime. On a true headless cold-launch (iOS terminated the app, then
// dispatches a region event) the runtime is fresh and the Map is empty —
// the task body's lat/lng lookup misses and the event is dropped before
// the filter chain runs.
//
// Fix: mirror the cache to AsyncStorage on every successful
// `registerGeofences()` and rehydrate at module-evaluation time. The
// rehydration Promise is stashed module-scope so the task body can `await`
// it on cache miss exactly once per process — subsequent fires hit the
// already-resolved Promise without re-reading storage.

interface SerializedCacheEntry {
  id: string;
  project: GeofenceEligibleProject;
}

function serializeCache(): string {
  const entries: SerializedCacheEntry[] = [];
  for (const [id, project] of lastRegisteredCache) entries.push({ id, project });
  return JSON.stringify(entries);
}

function parseSerializedCache(raw: string): SerializedCacheEntry[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const out: SerializedCacheEntry[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") return null;
      const r = item as Record<string, unknown>;
      const id = r.id;
      const p = r.project;
      if (typeof id !== "string" || !p || typeof p !== "object") return null;
      const pr = p as Record<string, unknown>;
      if (
        typeof pr.id !== "number" ||
        typeof pr.name !== "string" ||
        typeof pr.latitude !== "number" ||
        typeof pr.longitude !== "number" ||
        typeof pr.lastActivityAt !== "string"
      ) {
        return null;
      }
      out.push({
        id,
        project: {
          id: pr.id,
          name: pr.name,
          latitude: pr.latitude,
          longitude: pr.longitude,
          lastActivityAt: pr.lastActivityAt,
        },
      });
    }
    return out;
  } catch {
    return null;
  }
}

async function rehydrateRegisteredCacheFromStorage(): Promise<void> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(REGISTERED_CACHE_STORAGE_KEY);
  } catch (err) {
    console.log(
      "[geofence] rehydrate: AsyncStorage read failed:",
      err instanceof Error ? err.message : err,
    );
    return;
  }
  if (!raw) {
    console.log("[geofence] rehydrate: no persisted snapshot");
    return;
  }
  const entries = parseSerializedCache(raw);
  if (!entries) {
    console.log("[geofence] rehydrate: snapshot unparseable, ignoring");
    return;
  }
  // Fill ONLY missing keys. A concurrent foreground sync may have run
  // between module load and rehydrate resolution — its data is fresher
  // (came from server, not snapshot), so we never overwrite.
  let filled = 0;
  for (const { id, project } of entries) {
    if (!lastRegisteredCache.has(id)) {
      lastRegisteredCache.set(id, project);
      filled++;
    }
  }
  console.log(
    `[geofence] rehydrate: filled ${filled} of ${entries.length} entries from storage`,
  );
}

// Module-scoped Promise so the task body can await the same in-flight
// rehydration. Initialized when the bootstrap block below runs.
let rehydrationPromise: Promise<void> | null = null;

async function persistRegisteredCacheToStorage(): Promise<void> {
  try {
    await AsyncStorage.setItem(
      REGISTERED_CACHE_STORAGE_KEY,
      serializeCache(),
    );
  } catch (err) {
    console.log(
      "[geofence] persist: AsyncStorage write failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

async function clearRegisteredCacheStorage(): Promise<void> {
  try {
    await AsyncStorage.removeItem(REGISTERED_CACHE_STORAGE_KEY);
  } catch (err) {
    console.log(
      "[geofence] clear-storage failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

// Per-region debounce timestamps (epoch ms). Set after a successful
// clock-in (via `recordClockInForRegion`, called from the banner) and
// after we observe the user is already clocked in. Cleared on full
// unregister and on app process kill (intentional — fresh process means
// "no recent prompts known", default to allow).
const lastClockInByRegion = new Map<string, number>();

/**
 * Mark that the user just clocked in to a region (auto OR manual).
 * Primes the per-region debounce so we don't auto-clock-in again
 * while GPS jitters at the boundary. Called by the silent-auto
 * sequence in the task body BEFORE the API call (retry-storm
 * protection), AND by the task body when it observes the user is
 * already clocked in to the entered region.
 */
export function recordClockInForRegion(projectId: number): void {
  lastClockInByRegion.set(regionIdFor(projectId), Date.now());
}

// ---------------------------------------------------------------------------
// Module-top-level TaskManager bootstrap
// ---------------------------------------------------------------------------
//
// `defineTask` MUST be called at JS module-evaluation time so the task
// is registered before iOS can invoke it. iOS may wake the app
// headlessly for a geofence event (no React mount, no useEffect) — the
// OS instantiates the JS runtime, looks up the task by name, and fires
// it. If the task wasn't defined at module load, the event is dropped
// silently.
//
// Use synchronous `require()` in a try/catch so the current Dev Build
// (which lacks the expo-task-manager native binding) fails soft instead
// of crashing on launch:
//   - require() throws → caught → taskManagerAvailable stays false
//     → registerGeofences early-returns with an error entry, the hook
//       and the rest of the app are unaffected.
//   - Session 34 EAS rebuild (native module present) → require()
//     succeeds → defineTask runs at module load → ready for OS
//     cold-launch invocation in true background.

/**
 * Top-level TaskManager dispatch. Hoisted to module scope so both the
 * real TaskManager callback AND the dev-only synthetic-trigger
 * buttons in profile.tsx invoke the exact same code path — same
 * parse, same branch, same downstream filters. Only the event source
 * differs.
 *
 * Shared filter (1) runs first; then we branch on eventType into
 * `handleGeofenceEnter` (S31b clock-in chain + cancel-pending-exit
 * pre-check) or `handleGeofenceExit` (S32a-mobile pending-exit POST
 * chain). Anything else is logged and dropped.
 */
async function runGeofenceTaskBody(
  args: {
    data: unknown;
    error: unknown;
  },
  opts?: { bypassFilters?: boolean },
): Promise<void> {
  const { data, error } = args;
  const bypassFilters = opts?.bypassFilters === true;
  if (bypassFilters) {
    console.log(
      "[geofence] DEBUG: bypassing proximity + GPS filters (test mode)",
    );
  }
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
  const regionId = payload?.region?.identifier;
  const eventType = payload?.eventType;

  console.log(
    `[geofence] task fired: eventType=${eventType} region=${regionId} appState=${AppState.currentState}`,
  );

  // ----- Shared Filter 1: parse + cache lookup -----
  if (!regionId) {
    console.log("[geofence] rejected: missing region identifier");
    return;
  }
  const projectId = parseProjectId(regionId);
  if (projectId === null) {
    console.log(`[geofence] rejected: malformed region id "${regionId}"`);
    return;
  }
  let project = lastRegisteredCache.get(regionId);
  if (!project) {
    // Cache miss path. On a true headless cold-launch from a background
    // region event, iOS instantiates a fresh JS runtime → modules
    // evaluate → defineTask + rehydrationPromise both kick off → this
    // task body fires before the React tree (and therefore before the
    // foreground `registerGeofences` call) ever runs.
    //
    // Await the module-load rehydration (with a hard cap so an
    // unresponsive AsyncStorage can't pin the OS task forever) and
    // retry the lookup. On second miss we give up — the region is
    // genuinely unknown (e.g. user removed from project between
    // launches, or stale region from an earlier app version).
    if (rehydrationPromise) {
      try {
        await Promise.race([
          rehydrationPromise,
          new Promise<void>((_, reject) =>
            setTimeout(
              () => reject(new Error("rehydrate timeout")),
              REHYDRATE_TIMEOUT_MS,
            ),
          ),
        ]);
      } catch (err) {
        console.log(
          "[geofence] rehydrate await failed:",
          err instanceof Error ? err.message : err,
        );
      }
      project = lastRegisteredCache.get(regionId);
    }
    if (project) {
      console.log(
        `[geofence] cache rehydrated from storage: ${regionId} (${project.name})`,
      );
    } else {
      console.log(
        `[geofence] rejected: ${regionId} not in registration cache (cold-launch race?)`,
      );
      return;
    }
  }

  // ----- Branch on event type -----
  if (eventType === Location.GeofencingEventType.Enter) {
    await handleGeofenceEnter(projectId, regionId, project, bypassFilters);
  } else if (eventType === Location.GeofencingEventType.Exit) {
    await handleGeofenceExit(projectId, regionId, project, bypassFilters);
  } else {
    console.log(
      `[geofence] ignored: unrecognized eventType=${eventType} for region ${regionId}`,
    );
  }
}

/**
 * S31b Enter chain — silent-auto clock-in with proximity/uncertainty
 * filters and per-region debounce. Caller (runGeofenceTaskBody) has
 * already done parse + cache lookup (shared Filter 1).
 *
 * Filter chain (ordered for cost: cheap first, then GPS, then network):
 *   0. Cancel-pending-exit (S32a-mobile) — runs FIRST so a re-enter
 *      during the 5-min debounce window cancels the server-side
 *      pending row even though Filter 3 (debounce) will short-circuit
 *      the silent-auto path (the user is still clocked in; we just
 *      revoke the scheduled auto-clock-out).
 *   3. Per-region debounce (cheap)         — drops bouncy boundary events
 *   4. getCurrentPositionAsync (blocking)  — needed for proximity filter
 *   5. GPS uncertainty (cheap, post-fix)   — guards against meaningless distance check
 *   6. Haversine proximity (cheap)         — kills the iOS registration storm
 *   7. Already-clocked-in (network)        — last because most expensive
 *
 * On pass: silently call api.clockIn(source: "auto_geofence") and
 * fire a local notification receipt on success. NO user confirmation
 * — silent-auto is the S31b default. On fail: log + return; geofence
 * stays armed and the next legitimate event will re-trigger the
 * chain.
 *
 * Auth note: api.activeTimesheet() relies on the cookie jar in
 * services/api.ts being rehydrated from Keychain. If headless
 * cold-launch can't reach Keychain, the call 401s and we abort —
 * the user just doesn't get auto-clock-in for that event, which
 * is correct fail-safe behavior. No re-login attempt from headless.
 */
async function handleGeofenceEnter(
  projectId: number,
  regionId: string,
  project: GeofenceEligibleProject,
  bypassFilters: boolean,
): Promise<void> {
  // ----- Filter -1: master toggle (S33) -----
  // Read from AsyncStorage (mirrored by AuthContext) because the OS
  // dispatches into this task outside the React tree — useAuth() is
  // unreachable here. Runs BEFORE Filter 0 (cancel-pending-exit-on-
  // re-enter) so a user who toggled auto-tracking off mid-trip doesn't
  // keep mutating server-side pending rows. Pending exits already
  // scheduled server-side will still fire as planned (the toggle
  // governs *new* OS events, not in-flight server state — surfaced
  // as a toast in profile.tsx on toggle-off).
  if (!(await autoTrackingPref.get())) {
    console.log("[geofence] auto-tracking disabled, skipping enter");
    return;
  }

  // ----- Filter 0: cancel pending-exit on re-enter (S32a-mobile) -----
  //
  // MUST run before Filter 3. When the user steps out and back in
  // within 5 minutes, the per-region debounce IS armed (from the
  // original clock-in), so Filter 3 would short-circuit before we
  // get a chance to revoke the server-side pending row. By the time
  // the cron fires, the user is back inside and the auto-clock-out
  // becomes a UX surprise.
  await cancelPendingExitsOnReEnter(regionId, project.name);

  // ----- Filter 3: per-region debounce -----
  const lastClockIn = lastClockInByRegion.get(regionId);
  if (lastClockIn !== undefined) {
    const ageMs = Date.now() - lastClockIn;
    if (ageMs < DEBOUNCE_MS) {
      const ageMin = Math.round(ageMs / 60_000);
      console.log(
        `[geofence] rejected: ${project.name} debounced (last clock-in ${ageMin}m ago)`,
      );
      return;
    }
  }

  // ----- Filters 4-6: GPS fix + uncertainty + haversine proximity -----
  // Skipped wholesale when bypassFilters is set — the GPS call is the
  // most expensive step and the only one a desk-bound tester can't
  // legitimately satisfy. Debounce (3) and already-clocked-in (7)
  // still run because their guarantees are independent of location.
  let distanceM = -1;
  let accuracy = -1;
  if (!bypassFilters) {
    let position: Location.LocationObject;
    try {
      position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
        mayShowUserSettingsDialog: false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[geofence] rejected: getCurrentPositionAsync failed: ${msg}`);
      return;
    }

    accuracy = position.coords.accuracy ?? Number.POSITIVE_INFINITY;
    if (accuracy > GPS_ACCURACY_THRESHOLD_M) {
      console.log(
        `[geofence] rejected: GPS uncertainty too high (${Math.round(accuracy)}m, threshold ${GPS_ACCURACY_THRESHOLD_M}m)`,
      );
      return;
    }

    distanceM = haversineMeters(position.coords, {
      latitude: project.latitude,
      longitude: project.longitude,
    });
    if (distanceM > PROXIMITY_THRESHOLD_M) {
      console.log(
        `[geofence] rejected: device ${Math.round(distanceM)}m from ${project.name} (radius ${RADIUS_METERS}m, threshold ${PROXIMITY_THRESHOLD_M}m)`,
      );
      return;
    }
  }

  // ----- Filter 7: already clocked in -----
  let active: Awaited<ReturnType<typeof api.activeTimesheet>>;
  try {
    active = await api.activeTimesheet();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      console.log(
        "[geofence] auth failed: session expired; deferring to next foreground sync",
      );
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[geofence] rejected: activeTimesheet check failed: ${msg}`);
    return;
  }
  if (active !== null) {
    console.log(
      `[geofence] rejected: ${project.name} — user already clocked in (entry id ${active.id}, project ${active.projectId})`,
    );
    // Stamp debounce timestamp here even though we didn't actually clock in.
    // If we don't, GPS jitter at this region's boundary will re-fire activeTimesheet()
    // network calls every few seconds while the user remains clocked into another
    // project. Trade-off: if the user clocks OUT of the current project within the
    // next 5 minutes, this region won't auto-prompt them — they'd have to re-cross
    // the boundary OR wait for debounce expiry. Acceptable for v1.
    recordClockInForRegion(projectId);
    return;
  }

  // ----- All filters passed: silent-auto clock-in + receipt -----
  if (bypassFilters) {
    console.log(
      `[geofence] enter accepted (BYPASS): ${project.name} — proximity/GPS skipped`,
    );
  } else {
    console.log(
      `[geofence] enter accepted: ${project.name} (${Math.round(distanceM)}m away, GPS ±${Math.round(accuracy)}m)`,
    );
  }

  // Stamp the per-region debounce BEFORE the API call, not after.
  //
  // Trade-off (S31b decision):
  //   - Stamping FIRST means a failed clockIn (network drop, 5xx,
  //     etc.) leaves the debounce armed → no retry until the 5-min
  //     window expires OR the user manually clocks in. The cost is
  //     a "missed auto clock-in on first try" if the backend is
  //     down at the exact moment of the boundary crossing.
  //   - Stamping AFTER success means a failed clockIn allows the
  //     next iOS retrigger (GPS jitter at the boundary fires
  //     enter/exit/enter constantly) to immediately retry → during
  //     a backend outage we hammer /api/timesheets/clock-in with a
  //     POST every few seconds per region per user. That's a retry
  //     storm we cannot afford.
  //
  // We accept the missed-on-failure cost in exchange for retry-storm
  // protection. If field reports show "first auto clock-in of the
  // day frequently misses," revisit with a bounded retry inside this
  // function (e.g. 1 retry after 30s, then give up) rather than by
  // unstamping the debounce.
  recordClockInForRegion(projectId);

  let entry: Awaited<ReturnType<typeof api.clockIn>>;
  try {
    entry = await api.clockIn(projectId, undefined, "auto_geofence");
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      console.log("[geofence] auth failed: session expired");
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[geofence] silent-auto failed: ${msg}`);
    return;
  }

  console.log(
    `[geofence] silent-auto clock-in: ${project.name} (entry ${entry.id})`,
  );

  // Receipt notification fires AFTER api.clockIn resolves successfully.
  // If we ever swap the ordering ("show notification first, request
  // later"), we'd be telling the user "you're clocked in" when no DB
  // row exists yet — a worse UX than a missed receipt.
  await fireClockInReceipt(
    project.name,
    projectId,
    // BackendTimesheetEntry types entry.id as `string | number` because
    // the wire payload has historically tolerated both. The receipt
    // payload is wire-typed as string and the deep-link handler treats
    // it as opaque, so coerce here at the boundary.
    String(entry.id),
    new Date(entry.clockIn),
  );
}

/**
 * Cancel any pending-exit rows for a region the user just re-entered.
 * Best-effort: server cancel POST failures drop the local record
 * anyway and let the server fire (post-facto discovery in
 * TimesheetContext will surface the kind="out" receipt with Undo).
 *
 * Server's partial unique index on pending_geofence_exits
 * (WHERE status='pending') guarantees ≤ 1 record per (timeEntryId,
 * projectId), so > 1 here = local persistence corruption. Logged to
 * Sentry for investigation but we still process all of them.
 */
async function cancelPendingExitsOnReEnter(
  regionId: string,
  projectName: string,
): Promise<void> {
  let pending;
  try {
    pending = await findPendingExitsForRegion(regionId);
  } catch (err) {
    console.log("[geofence] cancel-pending-exit: lookup failed:", err);
    return;
  }
  if (pending.length === 0) return;

  if (pending.length > 1) {
    Sentry.captureException(
      new Error(
        `[geofence] multiple pending exits for region ${regionId} (expected ≤ 1)`,
      ),
      {
        extra: {
          regionId,
          count: pending.length,
          ids: pending.map((p) => p.pendingExitId),
        },
      },
    );
  }

  // SAFE: B5 in handleGeofenceExit is idempotent (early-returns on
  // any pre-existing pending row for this region) and the server's
  // cancel endpoint is idempotent (cancelling an already-cancelled
  // row is a no-op). A duplicate Exit event arriving mid-cancel
  // therefore can't double-fire or race the cancel into a fired
  // state. Worst case under concurrent dispatch: one redundant
  // server roundtrip.
  for (const record of pending) {
    if (record.pendingExitId !== null) {
      try {
        await api.geofenceExitCancelled(record.pendingExitId);
        await removePendingExitById(record.pendingExitId);
        console.log(
          `[geofence] re-enter cancelled pending exit ${record.pendingExitId} for ${projectName}`,
        );
      } catch (err) {
        // Failure mode: drop the local record anyway. If the server
        // still fires, post-facto discovery surfaces the kind="out"
        // receipt and the user can Undo. No retry queue for cancel
        // — keeps the state machine simple. Revisit if field
        // reports show this surprises users in practice.
        const msg = err instanceof Error ? err.message : String(err);
        console.log(
          `[geofence] re-enter cancel POST failed (${msg}); dropping local record anyway`,
        );
        Sentry.captureException(err, {
          extra: {
            phase: "exit-cancelled",
            regionId,
            pendingExitId: record.pendingExitId,
          },
        });
        await removePendingExitById(record.pendingExitId);
      }
    } else {
      // Unsent retry state: no server-side row exists, nothing to
      // cancel. Just drop the local record so the next foreground
      // doesn't try to retry-POST exit-detected for an exit the
      // user has now reversed.
      await removePendingExitByCompoundKey(record.timeEntryId, record.regionId);
      console.log(
        `[geofence] re-enter dropped unsent pending exit (no server row to cancel) for ${projectName}`,
      );
    }
  }
}

/**
 * S32a-mobile Exit chain — POST /api/geofence/exit-detected so the
 * server schedules the auto-clock-out 5 minutes from now. Caller
 * (runGeofenceTaskBody) has already done parse + cache lookup
 * (shared Filter 1).
 *
 * Filter chain (B-prefix to keep visually distinct from the Enter
 * chain in logs):
 *   B5. Already-pending (cheap, local) — runs FIRST as a free
 *       short-circuit. The OS sometimes fires Exit twice for the
 *       same region; we don't want to double-POST.
 *   B2. Active session (network)        — no session = nothing to debounce
 *   B3. Project match (cheap)           — exit is for a region the user
 *                                         isn't currently clocked into
 *   B4. Source === auto_geofence (CRITICAL) — manual sessions are NEVER
 *                                         debounced; the user explicitly
 *                                         clocked in and would be surprised
 *                                         by an auto-clock-out
 *   B1. GPS uncertainty (network/HW)    — last sanity check; skipped in
 *                                         bypassFilters (synthetic test)
 *
 * On pass: POST exit-detected, persist returned id+firesAt locally
 * via upsertPendingExit. On POST failure: persist with
 * pendingExitId=null + unsent=true so the foreground retry in
 * TimesheetContext (Diff 5) can re-attempt.
 */
async function handleGeofenceExit(
  projectId: number,
  regionId: string,
  project: GeofenceEligibleProject,
  bypassFilters: boolean,
): Promise<void> {
  // ----- Filter B0: master toggle (S33) -----
  // Same rationale as the matching gate at the top of
  // handleGeofenceEnter. AsyncStorage mirror, not React context.
  if (!(await autoTrackingPref.get())) {
    console.log("[geofence] auto-tracking disabled, skipping exit");
    return;
  }

  // ----- Filter B5 (early): already-pending short-circuit -----
  let existing: Awaited<ReturnType<typeof findPendingExitsForRegion>> = [];
  try {
    existing = await findPendingExitsForRegion(regionId);
  } catch (err) {
    console.log("[geofence] exit: pending-lookup failed:", err);
  }
  if (existing.length > 1) {
    Sentry.captureException(
      new Error(
        `[geofence] multiple pending exits for region ${regionId} (expected ≤ 1)`,
      ),
      {
        extra: {
          regionId,
          count: existing.length,
          ids: existing.map((p) => p.pendingExitId),
        },
      },
    );
  }
  if (existing.length > 0) {
    console.log(
      `[geofence] exit suppressed: pending exit already exists for ${project.name}`,
    );
    return;
  }

  // ----- Filter B2: active session check -----
  let active: Awaited<ReturnType<typeof api.activeTimesheet>>;
  try {
    active = await api.activeTimesheet();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      console.log(
        "[geofence] exit: auth failed (session expired); deferring",
      );
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[geofence] exit rejected: activeTimesheet check failed: ${msg}`);
    return;
  }
  if (active === null) {
    console.log(
      `[geofence] exit ignored: no active session (nothing to debounce)`,
    );
    return;
  }

  // ----- Filter B3: project match -----
  // active.projectId is `number | string` per the wire contract.
  const activeProjectId =
    typeof active.projectId === "number"
      ? active.projectId
      : Number(active.projectId);
  if (activeProjectId !== projectId) {
    console.log(
      `[geofence] exit ignored: active project ${activeProjectId} != exited region project ${projectId}`,
    );
    return;
  }

  // ----- Filter B4: source must be auto_geofence (CRITICAL) -----
  //
  // Manual sessions (source: "manual" | "edited" | null | undefined)
  // are NEVER auto-debounced. The user explicitly clocked themselves
  // in; an auto-clock-out triggered by the OS would be a UX surprise
  // that erodes trust in manual control. Auto-debounce is opt-in via
  // the auto_geofence enter path only.
  if (active.source !== "auto_geofence") {
    console.log(
      `[geofence] exit ignored: session source="${active.source}" — only auto_geofence sessions are debounced`,
    );
    return;
  }

  // ----- Filter B1: GPS uncertainty (skip in bypass mode) -----
  //
  // Heavy weather, indoor multipath, or a stale fix can produce a
  // phantom Exit even when the user hasn't moved. Reject if accuracy
  // is worse than threshold so we don't schedule an auto-clock-out
  // off a known-bad signal. No proximity check on Exit (the whole
  // point of Exit is the user is now far from the region).
  //
  // Ordering note: B1 runs LAST despite involving a hardware call.
  // Reason — B5 (local AsyncStorage) and B2-B4 (single network call
  // + two cheap field comparisons) collectively gate ~all rejection
  // paths; reaching B1 means we've already committed to caring about
  // this exit. No point spinning up the GPS receiver for events we'd
  // reject on cheaper grounds. B5 is first because it's free.
  if (!bypassFilters) {
    let position: Location.LocationObject;
    try {
      position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
        mayShowUserSettingsDialog: false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(
        `[geofence] exit rejected: getCurrentPositionAsync failed: ${msg}`,
      );
      return;
    }
    const accuracy = position.coords.accuracy ?? Number.POSITIVE_INFINITY;
    if (accuracy > GPS_ACCURACY_THRESHOLD_M) {
      console.log(
        `[geofence] exit rejected: GPS uncertainty too high (${Math.round(accuracy)}m, threshold ${GPS_ACCURACY_THRESHOLD_M}m)`,
      );
      return;
    }
  }

  // ----- All filters passed: POST exit-detected -----
  const detectedAt = new Date().toISOString();
  const timeEntryId = String(active.id);

  if (bypassFilters) {
    console.log(
      `[geofence] exit accepted (BYPASS): ${project.name} entry=${timeEntryId} — GPS skipped`,
    );
  } else {
    console.log(
      `[geofence] exit accepted: ${project.name} entry=${timeEntryId}`,
    );
  }

  try {
    const resp = await api.geofenceExitDetected({
      projectId,
      timeEntryId,
      detectedAt,
    });
    await upsertPendingExit({
      pendingExitId: resp.id,
      timeEntryId,
      projectId,
      regionId,
      firesAt: resp.firesAt,
      detectedAt,
    });
    console.log(
      `[geofence] exit persisted: pendingExitId=${resp.id} firesAt=${resp.firesAt}`,
    );
  } catch (err) {
    // Persist with unsent=true so the foreground retry in
    // TimesheetContext (Diff 5) can re-attempt the POST. firesAt
    // is a best-effort 5min-from-now estimate — used only for the
    // dead-record cleanup threshold in pendingExits.ts; the real
    // firesAt is never assigned because the server never accepted
    // this row. If the user re-enters before retry succeeds, the
    // cancel hook drops the local record without any server call.
    const msg = err instanceof Error ? err.message : String(err);
    console.log(
      `[geofence] exit POST failed; persisting unsent for retry: ${msg}`,
    );
    Sentry.captureException(err, {
      extra: {
        phase: "exit-detected",
        projectId,
        timeEntryId,
        regionId,
      },
    });
    await upsertPendingExit({
      pendingExitId: null,
      timeEntryId,
      projectId,
      regionId,
      firesAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      detectedAt,
      unsent: true,
    });
  }
}

/**
 * DEV-ONLY: synthesize a TaskManager geofence Enter event for the
 * given region id and run the filter chain against it. Lets us
 * validate the entire path (proximity, debounce, activeTimesheet,
 * banner) without waiting for a real iOS region transition.
 *
 * Default mode (`bypassFilters` unset/false): all filters run as the
 * real iOS event would, including `getCurrentPositionAsync` and
 * `api.activeTimesheet`. If the device is physically far from the
 * project, proximity rejects — useful for validating the filter is
 * doing its job.
 *
 * Force mode (`bypassFilters: true`): skips proximity (haversine) +
 * GPS uncertainty + the GPS call itself, so the prompt enqueues
 * regardless of physical location. Lets a desk-bound tester exercise
 * the banner → API → DB path without driving to a job site.
 * Debounce (Filter 3) and already-clocked-in (Filter 7) still run —
 * the former because rapid double-taps would otherwise spam the
 * queue, the latter because we can't fulfill a clock-in if one is
 * already active.
 *
 * Mounted only by the GeofenceDebugSection in profile.tsx behind
 * `__DEV__`. Defense-in-depth gate here too — calling this in a
 * release build is a programmer error, not a runtime path.
 */
export async function triggerSyntheticEnterForTesting(
  regionId: string,
  opts?: { bypassFilters?: boolean },
): Promise<void> {
  if (!__DEV__) {
    console.log(
      "[geofence] triggerSyntheticEnterForTesting called outside __DEV__; ignoring",
    );
    return;
  }
  const mode = opts?.bypassFilters ? "BYPASS" : "full filter chain";
  console.log(
    `[geofence] DEBUG: synthetic Enter triggered for ${regionId} (${mode})`,
  );
  await runGeofenceTaskBody(
    {
      data: {
        eventType: Location.GeofencingEventType.Enter,
        region: { identifier: regionId },
      },
      error: null,
    },
    opts,
  );
}

/**
 * DEV-ONLY: synthesize a TaskManager geofence Exit event for the
 * given region id and run the Exit filter chain against it. Mirror
 * of triggerSyntheticEnterForTesting — same dispatch path, same
 * bypassFilters semantics.
 *
 * Default mode: B1 (GPS uncertainty) runs as the real iOS event
 * would. If the device's GPS fix is poor, the exit is rejected.
 *
 * Force mode (`bypassFilters: true`): skips B1 only. B2 (active
 * session), B3 (project match), B4 (source check), and B5
 * (already-pending) still run because they're invariants the
 * server-side debounce contract depends on — bypassing them in a
 * test would create database state that doesn't match what
 * production would ever produce.
 *
 * Mounted by the GeofenceDebugSection in profile.tsx behind
 * `__DEV__`. Defense-in-depth gate here too — calling this in a
 * release build is a programmer error, not a runtime path.
 */
export async function triggerSyntheticExitForTesting(
  regionId: string,
  opts?: { bypassFilters?: boolean },
): Promise<void> {
  if (!__DEV__) {
    console.log(
      "[geofence] triggerSyntheticExitForTesting called outside __DEV__; ignoring",
    );
    return;
  }
  const mode = opts?.bypassFilters ? "BYPASS" : "full filter chain";
  console.log(
    `[geofence] DEBUG: synthetic Exit triggered for ${regionId} (${mode})`,
  );
  await runGeofenceTaskBody(
    {
      data: {
        eventType: Location.GeofencingEventType.Exit,
        region: { identifier: regionId },
      },
      error: null,
    },
    opts,
  );
}

let TaskManager: typeof import("expo-task-manager") | null = null;
let taskManagerAvailable = false;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  TaskManager = require("expo-task-manager") as typeof import("expo-task-manager");
  if (Platform.OS === "ios" && TaskManager) {
    // S31a real handler — delegates to runGeofenceTaskBody (above) so
    // the dev-only synthetic-trigger button shares the exact same path.
    TaskManager.defineTask(TASK_NAME, runGeofenceTaskBody);
    taskManagerAvailable = true;
  }
} catch (err) {
  console.log(
    "[geofence] expo-task-manager unavailable on this build; geofencing disabled",
    err,
  );
}

// Kick off cache rehydration at module-evaluation time, in parallel with
// whatever else mounts. Stash the Promise so the task body can await it
// on cache miss (cold-launch path). Fire-and-forget at module scope —
// awaiting here would block module import.
rehydrationPromise = rehydrateRegisteredCacheFromStorage();

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
  for (const id of lastRegisteredCache.keys()) {
    if (!desired.has(id)) result.unregistered.push(id);
  }

  // No-op if the desired set already matches.
  if (result.registered.length === 0 && result.unregistered.length === 0) {
    console.log(
      `[geofence] sync starting: no changes (${lastRegisteredCache.size} regions registered)`,
    );
    return result;
  }

  console.log(
    `[geofence] sync starting: +${result.registered.length} -${result.unregistered.length} (target ${desired.size})`,
  );

  if (!taskManagerAvailable) {
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
    for (const [id, project] of desired) lastRegisteredCache.set(id, project);

    // Mirror to AsyncStorage so headless cold-launch fires can rehydrate
    // before the React tree mounts. Best-effort: write failure logs but
    // never throws — registration itself already succeeded with the OS.
    await persistRegisteredCacheToStorage();

    console.log(
      `[geofence] registered ${desired.size} regions (skipped ${result.skipped.length} as unchanged)`,
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
    lastClockInByRegion.clear();
    // Drop the persisted snapshot too — otherwise after sign-out a stale
    // cache could fire events for the previous user's projects if the
    // device crosses one of those geofences before re-registration.
    await clearRegisteredCacheStorage();
  }
}

/**
 * Returns the identifiers of currently-registered regions (snapshot).
 * Reflects the last successful registerGeofences call; cleared by
 * unregisterAllGeofences. For debug surfacing.
 */
export function getRegisteredGeofences(): string[] {
  return Array.from(lastRegisteredCache.keys());
}

/** Constants exported for the debug surface and test harnesses. */
export const GEOFENCE_INTERNALS = {
  TASK_NAME,
  REGION_PREFIX,
  RADIUS_METERS,
  MAX_REGIONS,
} as const;
