import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";

import { ApiError, api } from "@/services/api";
import {
  getRegisteredRegions,
  haversineMeters,
  DEFAULT_GEOFENCE_RADIUS_M,
} from "@/services/geofencing";
import {
  listPendingEnters,
  upsertPendingEnter,
} from "@/services/pendingEnters";

/**
 * Already-inside-on-foreground detection (BUILD 13 / Diff 1).
 *
 * Closes a known gap in iOS region monitoring: the OS only dispatches
 * Enter events when the device CROSSES the boundary. If the geofence
 * task is suspended (app not opened in a while, OS power management,
 * background-refresh disabled) when the user arrives at a site, no
 * Enter fires. Opening the app while already inside the region does
 * NOT retroactively dispatch — iOS does not provide an "are you
 * currently inside any registered region?" API.
 *
 * Fix: on app foreground (and after a successful re-registration),
 * one-shot poll device location, haversine-test against every
 * registered region, and if we're inside the nearest one, POST
 * /api/geofence/enter-detected as if the OS had fired Enter. The
 * server's idempotency guard handles the rare race where iOS dispatches
 * Enter for the same region in the same window.
 *
 * Triggers (both wired by callers; this module exposes only the check):
 *   1. AppState 'active' transition listener in TimesheetContext.
 *   2. Tail of `registerGeofences()` in services/geofencing.ts —
 *      catches the "user has Always permission for the first time"
 *      case where iOS Enter would normally only fire on the NEXT
 *      crossing.
 *
 * Throttle: AsyncStorage gate (`STORAGE_KEY` below) skips runs <30s
 * apart. Foregrounds in quick succession (e.g. user toggling between
 * Field View and Maps) would otherwise hammer location services and
 * the enter-detected endpoint for no benefit.
 *
 * Active-session guard: caller passes `hasActiveTimesheet`. If true,
 * we skip — the user is already clocked in, an inside-check would only
 * cause a duplicate enter-detected the server would have to deduplicate.
 *
 * Pending-enter guard: we read `listPendingEnters()` and skip if any
 * row matches the nearest project. A pending enter means the dwell
 * window is already armed; a second enter-detected would either be
 * server-deduplicated or (worse) reset the dwell clock.
 *
 * Failure handling: every error path is silent (console.log only, no
 * Sentry). The whole module is a best-effort latency optimization —
 * if it can't run, the existing iOS task body + heartbeat backup +
 * server cron still cover the actual auto-clock-in semantics.
 */

/**
 * AsyncStorage key for the last-run timestamp throttle. Suffix `_v1`
 * matches the rest of the @fv/ namespace convention for forward
 * compat. Value is a stringified millisecond epoch.
 */
const STORAGE_KEY = "@fv/inside_check_last_run_at_v1";

/**
 * Minimum gap between successive inside-checks. 30s is short enough
 * that a legitimate "open app after arriving at a site" path still
 * gets the optimization, but long enough that foregrounding the app
 * repeatedly (notification taps, deep links, multitasking switches)
 * doesn't hammer location + network.
 */
const MIN_RUN_INTERVAL_MS = 30_000;

/**
 * Wall-clock cap on the location fix. 5s matches the heartbeat task
 * timeout — beyond that the user has likely backgrounded the app or
 * the GPS chip is failing to acquire, and we should give up rather
 * than block the foreground path.
 */
const LOCATION_TIMEOUT_MS = 5_000;

/**
 * In-process mutex. Foreground transitions and post-registration
 * triggers can fire within the same JS tick (e.g. user grants Always
 * permission while the app is foregrounded → the permission listener
 * calls registerGeofences which schedules its inside-check, and the
 * AppState handler may also fire from the permission dialog dismissal
 * roughly simultaneously). Without this gate, both calls would race
 * past the AsyncStorage throttle (which hasn't been written yet) and
 * potentially double-POST enter-detected.
 *
 * Module-scoped Promise: if a check is already in flight, the next
 * caller awaits the same Promise and effectively becomes a no-op
 * because the throttle will be armed by the time it gets to run its
 * own logic. We only need to gate concurrent ENTRY — re-entry after
 * the in-flight resolves is fine because the AsyncStorage throttle
 * takes over from there.
 */
let inFlight: Promise<void> | null = null;

export interface InsideCheckContext {
  /**
   * Whether the user is currently clocked into ANY project. When true,
   * the check is a no-op — server-side enter-detected would short-
   * circuit with `skipped: already_clocked_in` anyway, so this is a
   * client-side optimization to avoid the round-trip.
   *
   * Passed in (rather than imported from TimesheetContext) so this
   * module stays usable from non-React callers like geofencing.ts.
   */
  hasActiveTimesheet: boolean;
}

/**
 * Public entry point. Returns nothing — callers that want logging
 * should consult the console output, but they should NEVER await this
 * to gate UI. Treat it as fire-and-forget.
 *
 * Safe to call from anywhere (no React hooks, no platform branches —
 * works on iOS where it matters, no-ops on Android where there are no
 * registered regions to inside-check against).
 */
export async function checkInsideRegisteredGeofences(
  ctx: InsideCheckContext,
): Promise<void> {
  // Single-flight gate. If a check is already running, join it
  // instead of starting a second one. See `inFlight` docstring.
  if (inFlight) return inFlight;
  inFlight = runCheck(ctx).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runCheck(ctx: InsideCheckContext): Promise<void> {
  try {
    if (ctx.hasActiveTimesheet) {
      // Already clocked in. The OS-fired Enter would have been
      // skipped server-side anyway; we skip client-side to save the
      // round-trip.
      return;
    }

    // ---- Throttle ----
    const now = Date.now();
    const lastRunRaw = await AsyncStorage.getItem(STORAGE_KEY);
    const lastRun = lastRunRaw ? Number(lastRunRaw) : 0;
    if (Number.isFinite(lastRun) && now - lastRun < MIN_RUN_INTERVAL_MS) {
      console.log(
        `[inside-check] throttled (last run ${Math.round((now - lastRun) / 1000)}s ago)`,
      );
      return;
    }

    // ---- Registered regions ----
    const regions = getRegisteredRegions();
    if (regions.length === 0) {
      // No regions registered (Android, fresh install, signed out,
      // or no eligible projects). Nothing to compare against.
      return;
    }

    // ---- Foreground permission gate ----
    // Foreground permission is the floor for getCurrentPositionAsync.
    // We do NOT require Always here — even if permission was
    // downgraded since registration, a foreground inside-check still
    // works while the app is visible.
    const perm = await Location.getForegroundPermissionsAsync();
    if (perm.status !== "granted") {
      console.log(
        `[inside-check] foreground permission not granted (${perm.status}); skipping`,
      );
      return;
    }

    // ---- One-shot location fix ----
    // Balanced accuracy is the right tradeoff for proximity testing
    // against a 150m radius — High would burn battery for sub-meter
    // precision we don't need, Low would underflow the radius.
    //
    // Wrap in our own timeout because expo-location's `timeout` field
    // is advisory on iOS; some chip + sky conditions can hang for
    // 30s+ without firing the internal timer.
    let position: Location.LocationObject;
    try {
      position = await Promise.race([
        Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("location timeout")),
            LOCATION_TIMEOUT_MS,
          ),
        ),
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[inside-check] location fix failed: ${msg}`);
      // Persist the throttle even on failure so a stuck GPS chip
      // doesn't cause back-to-back attempts on every foreground.
      await AsyncStorage.setItem(STORAGE_KEY, String(now));
      return;
    }

    const { latitude, longitude } = position.coords;

    // ---- Find nearest region within radius ----
    let nearest: {
      regionId: string;
      projectId: number;
      projectName: string;
      distanceM: number;
    } | null = null;

    for (const { regionId, project } of regions) {
      const distanceM = haversineMeters(
        { latitude, longitude },
        { latitude: project.latitude, longitude: project.longitude },
      );
      if (distanceM > DEFAULT_GEOFENCE_RADIUS_M) continue;
      if (!nearest || distanceM < nearest.distanceM) {
        nearest = {
          regionId,
          projectId: project.id,
          projectName: project.name,
          distanceM,
        };
      }
    }

    // Always persist the throttle after a successful poll (whether or
    // not we matched a region) — the work of fetching the GPS fix is
    // what we're rate-limiting.
    await AsyncStorage.setItem(STORAGE_KEY, String(now));

    if (!nearest) {
      console.log(
        `[inside-check] not inside any registered region (${regions.length} checked)`,
      );
      return;
    }

    // ---- Pending-enter guard ----
    // If we already have a pending enter for this project, the dwell
    // is armed — re-posting would either be server-deduped or reset
    // the clock. Either way: skip.
    const pending = await listPendingEnters();
    if (pending.some((p) => p.projectId === nearest!.projectId)) {
      console.log(
        `[inside-check] pending enter already exists for ${nearest.projectName}; skipping`,
      );
      return;
    }

    // ---- POST enter-detected ----
    // detectedAt is "now" — same semantics as the iOS task body uses.
    // Server assigns its own firesAt off its own clock to avoid skew.
    const detectedAt = new Date(now).toISOString();
    console.log(
      `[inside-check] inside ${nearest.projectName} (${Math.round(nearest.distanceM)}m); posting enter-detected`,
    );
    try {
      const resp = await api.geofenceEnterDetected({
        projectId: nearest.projectId,
        regionId: nearest.regionId,
        detectedAt,
      });
      if ("status" in resp && resp.status === "skipped") {
        console.log(
          `[inside-check] server skipped (${resp.reason}); no local row persisted`,
        );
        return;
      }
      // Persist the pending-enter row so the standard cancel-on-leave
      // and post-facto-discovery paths in geofencing.ts +
      // TimesheetContext + PendingEnterBanner (Diff 2) treat this
      // exactly like an OS-fired enter.
      await upsertPendingEnter({
        pendingEnterId: resp.id,
        projectId: nearest.projectId,
        regionId: nearest.regionId,
        firesAt: resp.firesAt,
        detectedAt,
      });
      console.log(
        `[inside-check] persisted pendingEnterId=${resp.id} firesAt=${resp.firesAt}`,
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        console.log("[inside-check] auth expired; skipping");
        return;
      }
      // Silent per spec — the cron will still fire the auto-clock-in
      // if the OS subsequently dispatches a real Enter, and the
      // heartbeat backup will still detect actual presence. No
      // Sentry: foreground inside-check is best-effort latency
      // optimization, not a critical path.
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[inside-check] enter-detected POST failed: ${msg}`);
    }
  } catch (err) {
    // Outermost catch — anything that escaped the per-step handlers.
    // Inside-check must never throw to its callers (foreground path,
    // post-registration tail) because it's strictly optional work.
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[inside-check] unexpected error: ${msg}`);
  }
}
