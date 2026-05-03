import * as Location from "expo-location";
import { AppState, Platform } from "react-native";

import { api, ApiError } from "./api";

/**
 * iOS geofencing registration service.
 *
 * Maintains the iOS-registered geofence set in sync with the user's
 * recent-active projects, capped at the iOS hard limit of 20 regions.
 *
 * Session 31a scope: registration + real enter event handler with the
 * four-stage filter chain (proximity, GPS uncertainty, per-region
 * debounce, already-clocked-in suppression) + foreground prompt
 * emitter. Exit events, background push notifications, and the
 * AsyncStorage-persisted task log are deferred to S31b/S32.
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
const REGION_PREFIX = "fv-project-";
const RADIUS_METERS = 30;
const MAX_REGIONS = 20;

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

// Per-region debounce timestamps (epoch ms). Set after a successful
// clock-in (via `recordClockInForRegion`, called from the banner) and
// after we observe the user is already clocked in. Cleared on full
// unregister and on app process kill (intentional — fresh process means
// "no recent prompts known", default to allow).
const lastClockInByRegion = new Map<string, number>();

// Foreground prompt queue. FIFO with per-projectId dedupe.
//
// Pattern mirrors services/uploadQueue.ts: module-level array as the
// single source of truth, listeners are notified with the full queue
// snapshot on every mutation, callers separately `getClockInPromptQueue()`
// for the initial state at subscribe time.
//
// Realistic depth: 1-2. Unbounded in code (no max length) — a runaway
// queue would indicate a filter-chain bug, not a real-world scenario.
//
// Lifecycle: events queue regardless of whether a listener is mounted
// — if the app is backgrounded when an event passes the filter chain,
// the entry sits in the queue until the React tree foregrounds and the
// banner subscribes. Stale-queue caveat: if the user enters and then
// leaves a region without ever foregrounding, the prompt is still
// shown on next foreground (mildly confusing but bounded annoyance).
// S31b's local-push path makes this rare in practice.
export interface ClockInPromptEvent {
  projectId: number;
  projectName: string;
}
type QueueListener = (queue: ClockInPromptEvent[]) => void;
const promptQueue: ClockInPromptEvent[] = [];
const promptListeners = new Set<QueueListener>();

function notifyPromptListeners(): void {
  const snapshot = [...promptQueue];
  for (const listener of promptListeners) {
    try {
      listener(snapshot);
    } catch (err) {
      console.log("[geofence] prompt listener threw:", err);
    }
  }
}

/**
 * Subscribe to clock-in prompt queue updates. Listener is called with
 * the full queue snapshot on every mutation (enqueue + dismiss).
 * Callers should separately invoke `getClockInPromptQueue()` for the
 * initial state at subscribe time. Returns the unsubscribe handle.
 *
 * Mounted by `<ClockInPromptBanner>` inside the tabs layout.
 */
export function subscribeToClockInPrompts(listener: QueueListener): () => void {
  promptListeners.add(listener);
  return () => {
    promptListeners.delete(listener);
  };
}

/** Snapshot of the current prompt queue (for initial render). */
export function getClockInPromptQueue(): ClockInPromptEvent[] {
  return [...promptQueue];
}

function enqueueClockInPrompt(event: ClockInPromptEvent): void {
  // Dedupe: a project already in the queue shouldn't be re-prompted.
  // GPS at the boundary can fire enter/exit/enter inside the
  // 5-min debounce window for a region the user hasn't responded to.
  if (promptQueue.some((e) => e.projectId === event.projectId)) {
    console.log(
      `[geofence] dedupe: project ${event.projectId} already in prompt queue (depth ${promptQueue.length})`,
    );
    return;
  }
  promptQueue.push(event);
  console.log(
    `[geofence] enqueued prompt for ${event.projectName} (queue depth: ${promptQueue.length})`,
  );
  notifyPromptListeners();
}

/**
 * Remove a prompt from the queue by projectId. Called by the banner
 * after Yes (post-clockIn) or Not now. Idempotent — no-op if the
 * projectId isn't in the queue.
 */
export function dismissClockInPrompt(projectId: number): void {
  const idx = promptQueue.findIndex((e) => e.projectId === projectId);
  if (idx === -1) return;
  promptQueue.splice(idx, 1);
  console.log(
    `[geofence] dismissed prompt for project ${projectId} (queue depth: ${promptQueue.length})`,
  );
  notifyPromptListeners();
}

/**
 * Mark that the user just clocked in to a region (auto OR manual).
 * Primes the per-region debounce so they don't get re-prompted while
 * GPS jitters at the boundary. Called by `<ClockInPromptBanner>` after
 * a successful clock-in, AND by the task body when it observes the
 * user is already clocked in to the entered region.
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
 * The S31a filter chain, hoisted to module scope so both the real
 * TaskManager callback AND the dev-only synthetic-trigger button in
 * profile.tsx can invoke the exact same code path. Same logic, same
 * GPS call, same network call — only the event source differs.
 *
 * Filter chain (ordered for cost: cheap checks first, then GPS,
 * then network):
 *   1. Parse + cache lookup (cheap)        — drops malformed/stale region ids
 *   2. eventType !== Enter (cheap)         — ignores exits (S32 handles)
 *   3. Per-region debounce (cheap)         — drops bouncy boundary events
 *   4. getCurrentPositionAsync (blocking)  — needed for proximity filter
 *   5. GPS uncertainty (cheap, post-fix)   — guards against meaningless distance check
 *   6. Haversine proximity (cheap)         — kills the iOS registration storm
 *   7. Already-clocked-in (network)        — last because most expensive
 *
 * On pass: enqueue prompt for the foreground banner. On fail: log +
 * return; geofence stays armed and the next legitimate event will
 * re-trigger the chain.
 *
 * Auth note: api.activeTimesheet() relies on the cookie jar in
 * services/api.ts being rehydrated from Keychain. If headless
 * cold-launch can't reach Keychain, the call 401s and we abort —
 * the user just doesn't get auto-clock-in for that event, which
 * is correct fail-safe behavior. No re-login attempt from headless.
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

  // ----- Filter 1: parse + cache lookup -----
  if (!regionId) {
    console.log("[geofence] rejected: missing region identifier");
    return;
  }
  const projectId = parseProjectId(regionId);
  if (projectId === null) {
    console.log(`[geofence] rejected: malformed region id "${regionId}"`);
    return;
  }
  const project = lastRegisteredCache.get(regionId);
  if (!project) {
    // Region fired but we have no record of registering it. Either
    // (a) cold-launch and registerGeofences hasn't run yet to
    // populate the cache, or (b) a stale region from a previous
    // version. Either way we can't compute proximity without lat/lng.
    //
    // Trade-off accepted for v1:
    //   1. The miss is bounded to a single event — iOS retriggers
    //      on the next region transition, by which point the
    //      foreground React tree will have populated the cache.
    //   2. The fix would require an AsyncStorage prefetch of the
    //      registered-region snapshot at module-evaluation time,
    //      which adds a persistence layer + cache-invalidation
    //      complexity (stale lat/lng if the project moves between
    //      app launches).
    //   3. Revisit only if field reports indicate "first auto
    //      clock-in of the day misses" — that's the symptom this
    //      gap would produce.
    console.log(
      `[geofence] rejected: ${regionId} not in registration cache (cold-launch race?)`,
    );
    return;
  }

  // ----- Filter 2: enter only -----
  if (eventType !== Location.GeofencingEventType.Enter) {
    console.log(
      `[geofence] ignored: eventType=${eventType} (only Enter handled in S31a)`,
    );
    return;
  }

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

  // ----- All filters passed: enqueue prompt -----
  if (bypassFilters) {
    console.log(
      `[geofence] enter accepted (BYPASS): ${project.name} — proximity/GPS skipped`,
    );
  } else {
    console.log(
      `[geofence] enter accepted: ${project.name} (${Math.round(distanceM)}m away, GPS ±${Math.round(accuracy)}m)`,
    );
  }
  enqueueClockInPrompt({ projectId, projectName: project.name });
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
    // Drop any pending prompts — they reference projects we no
    // longer have lat/lng for, and "always permission" was probably
    // just revoked, so prompting would be misleading anyway.
    if (promptQueue.length > 0) {
      promptQueue.length = 0;
      notifyPromptListeners();
    }
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
