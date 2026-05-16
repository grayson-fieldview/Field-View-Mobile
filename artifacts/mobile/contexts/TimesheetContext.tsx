import AsyncStorage from "@react-native-async-storage/async-storage";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState } from "react-native";

import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/contexts/ToastContext";
import { ApiError, api } from "@/services/api";
import type { BackendTimesheetEntry } from "@/services/api";
import { startHeartbeat, stopHeartbeat } from "@/services/heartbeat";
import { checkInsideRegisteredGeofences } from "@/services/insideCheck";
import {
  listPendingEnters,
  listUnsentPendingEnters,
  removePendingEnterById,
  removePendingEntersByProjectId,
  upsertPendingEnter,
} from "@/services/pendingEnters";
import {
  listPendingExits,
  listUnsentPendingExits,
  removePendingExitByTimeEntryId,
  upsertPendingExit,
} from "@/services/pendingExits";
import { Sentry } from "@/services/sentry";

/**
 * Storage key for the last-known-active timesheet entry.
 *
 * Why we persist: the post-fact discovery block compares
 * prev-active to next-active to detect server-fired auto-clock-
 * outs. In live foreground transitions, prev is held in
 * `activeRef`. But on cold-launch, activeRef is null at mount,
 * so we'd miss any fire that happened while the app was killed
 * — which is the highest-value path of S32a (user backgrounds
 * app overnight, cron fires after their shift ends, user opens
 * app the next morning, expects to see "you were auto-clocked
 * out" with an Undo affordance).
 *
 * Underscore convention matches @fv/pending_exits_v1 and
 * @fv/upload_queue_v1; v1 suffix reserves room for shape
 * migrations without storage-key collisions.
 */
const LAST_SEEN_KEY = "@fv/last_seen_active_v1";

/**
 * Surfaced when the foreground refresh observes that a
 * previously-active entry is no longer current AND we have a
 * local pending-exit record matching that entry id. Indicates
 * the server's auto-clock-out cron fired while we weren't
 * looking — the project detail screen consumes this to render
 * a kind="out" receipt banner with an Undo affordance.
 *
 * `entry` is the LAST-KNOWN active entry (the prev value,
 * captured before refresh observed null OR a different session).
 * It carries the original projectId and clockIn but `clockOut`
 * is null by definition (the prev snapshot predates the fire).
 * Consumers should NOT read `entry.clockOut` for display — use
 * `firedAt` instead.
 *
 * `firedAt` is the matched pendingExit.firesAt — the time the
 * server's debounce window expired and the cron became eligible
 * to fire. The cron polls every minute from that point, so
 * firedAt approximates the actual server clockOut time to
 * within ~60 seconds. Precise enough for the conversational
 * "Just clocked out at {time}" copy.
 */
export interface FiredExit {
  entry: BackendTimesheetEntry;
  firedAt: string;
}

/**
 * Mirror of FiredExit for the dwell-time auto-clock-IN path
 * (S3x-mobile). Surfaced when:
 *   - foreground refresh observes a transition from no active
 *     session → an `auto_geofence` session AND the new session's
 *     projectId matches a local pending-enter row (post-facto
 *     discovery), OR
 *   - the foreground push handler in app/_layout.tsx receives a
 *     server-pushed clock_in_receipt while the app is foregrounded.
 *
 * `entry` is the FRESHLY-FETCHED active entry (from
 * api.activeTimesheet) on the discovery path; on the foreground-push
 * path, a synthetic minimal BackendTimesheetEntry built from the
 * push payload (timeEntryId/projectId/clockInAt). Consumers
 * (ClockReceiptBanner kind="in") read only id + projectId + the
 * sibling `firedAt` field.
 *
 * `firedAt` is the matched pendingEnter.firesAt on the discovery
 * path (~60s after detectedAt), or the push payload's clockInAt on
 * the foreground-push path (server's actual clock-in time).
 */
export interface FiredEnter {
  entry: BackendTimesheetEntry;
  firedAt: string;
}

export interface TimesheetState {
  active: BackendTimesheetEntry | null;
  ready: boolean;
  loading: boolean;
  refresh: () => Promise<void>;
  clockIn: (
    projectId: string | number,
    notes?: string,
  ) => Promise<BackendTimesheetEntry | null>;
  clockOut: (notes?: string) => Promise<BackendTimesheetEntry | null>;
  /**
   * Non-null when the foreground refresh discovered a server-
   * fired auto-clock-out. Cleared by `dismissFiredExit` (called
   * by the receipt banner on user X tap or after a successful
   * Undo). Multiple fires across sessions are at-most-one — the
   * second overwrites the first, which is acceptable because
   * fires are rare (one per session) and the relevance window
   * closes within minutes.
   */
  firedExit: FiredExit | null;
  dismissFiredExit: () => void;
  /**
   * Imperative setter so the foreground push handler can surface a
   * server-pushed clock_out_receipt as a kind="out" receipt banner.
   * Construction of the synthetic FiredExit happens at the call site
   * (the push payload doesn't carry the full BackendTimesheetEntry —
   * only id + projectId + clockOutAt — but the kind="out" banner
   * reads only those fields plus firedAt, so a minimal entry is
   * sufficient). Pass null to clear; callers preferring symmetry
   * with `dismissFiredExit` should use that instead.
   */
  setFiredExit: (next: FiredExit | null) => void;
  /**
   * Mirror of `firedExit` for the dwell-time auto-clock-IN path.
   * Non-null when the foreground refresh discovered (or the
   * foreground push handler received) a server-fired auto-clock-in.
   * Cleared by `dismissFiredEnter`. Same at-most-one semantics as
   * firedExit — fires are rare (one per dwell window) and the
   * relevance window closes within minutes.
   */
  firedEnter: FiredEnter | null;
  dismissFiredEnter: () => void;
  /** Symmetric to `setFiredExit` for the foreground push handler. */
  setFiredEnter: (next: FiredEnter | null) => void;
}

const TimesheetContext = createContext<TimesheetState | undefined>(undefined);

export function TimesheetProvider({ children }: { children: React.ReactNode }) {
  const { user, ready: authReady } = useAuth();
  const { showToast } = useToast();
  const [active, setActive] = useState<BackendTimesheetEntry | null>(null);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [firedExit, setFiredExit] = useState<FiredExit | null>(null);
  const [firedEnter, setFiredEnter] = useState<FiredEnter | null>(null);

  // Single in-flight guard shared by refresh AND mutations so a
  // background foreground-refresh can't race with (and clobber) an
  // optimistic clockIn / clockOut result.
  const inFlightRef = useRef(false);

  // Mirror of `active` for use inside async callbacks whose
  // useCallback deps shouldn't include `active` (we don't want
  // refresh's identity to thrash on every poll). Read at the
  // START of refresh as the "previous" value to compare against
  // the freshly-fetched one.
  //
  // Two write paths populate this ref:
  //   1. The mirroring effect below — fires on every commit where
  //      `active` changed.
  //   2. The cold-start hydration in the initial-fetch effect —
  //      reads LAST_SEEN_KEY from AsyncStorage and seeds the ref
  //      BEFORE the first refresh runs.
  //
  // Ordering subtlety: on first mount, the mirroring effect runs
  // first (synchronous useEffect body) and sets the ref to null
  // (the initial state value). The hydration IIFE in the initial-
  // fetch effect then runs as a microtask, awaits AsyncStorage,
  // and overwrites with the hydrated value before calling refresh.
  // Microtask ordering guarantees the hydration completes before
  // refresh's network round-trip resolves. If you ever add an
  // `await` to the mirroring effect or convert it to async, this
  // ordering breaks — keep it synchronous.
  const activeRef = useRef<BackendTimesheetEntry | null>(null);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  // Heartbeat lifecycle (BUILD 12, server-side exit-detection
  // backup). Starts the background-location task when a session
  // opens, stops it when the session closes. Single source of truth
  // for transitions: every clock-in / clock-out / cancellation /
  // post-fact-discovery path converges on `setActive(...)` here, so
  // a deps:[active] effect catches every transition automatically.
  //
  // Defensive on id change WITHOUT going through null:
  // clock-out → clock-in normally settles `active` to null between
  // them (separate setActive calls), but if the discovery path or
  // a future code path ever moved A → B in a single update, we'd
  // leak a heartbeat task tagged to the wrong session. The
  // stop-then-start sequence below ensures the task is restarted
  // cleanly on any non-equal id transition.
  //
  // start/stop are idempotent and themselves no-op on web /
  // missing native module, so this effect is safe to call
  // unconditionally.
  const heartbeatPrevIdRef = useRef<string | null>(null);
  useEffect(() => {
    const nextId = active?.id != null ? String(active.id) : null;
    const prevId = heartbeatPrevIdRef.current;
    if (nextId === prevId) return;
    heartbeatPrevIdRef.current = nextId;

    if (prevId !== null && nextId === null) {
      // Session ended.
      void stopHeartbeat();
    } else if (prevId === null && nextId !== null) {
      // Session opened.
      void startHeartbeat();
    } else {
      // Session changed id without going through null. Defensive
      // restart so the running task isn't tagged to a stale
      // session from the server's perspective. (Not expected in
      // current code paths but cheap to guard against.)
      void (async () => {
        await stopHeartbeat();
        await startHeartbeat();
      })();
    }
  }, [active]);

  /**
   * Foreground retry of any unsent exit-detected POSTs. Fire-
   * and-forget — does not block setReady or UI gating. Each
   * unsent record gets one POST attempt; on success we upsert
   * with the real server id+firesAt and clear `unsent`, on
   * failure the record is left alone for the next foreground.
   *
   * No retry budget / backoff: AppState foreground transitions
   * are naturally rate-limited (user has to background and
   * reopen the app), and the dead-record cleanup in
   * pendingExits.ts eventually prunes records whose firesAt-
   * estimate has long passed (60min post-estimate). If the
   * server is genuinely unreachable for that long, the unsent
   * record times out without further harm.
   */
  const retryUnsentExits = useCallback(async () => {
    let unsent;
    try {
      unsent = await listUnsentPendingExits();
    } catch (err) {
      console.log("[Timesheet] unsent-exit list failed:", err);
      return;
    }
    if (unsent.length === 0) return;
    console.log(`[Timesheet] retrying ${unsent.length} unsent exit(s)`);
    for (const record of unsent) {
      try {
        const resp = await api.geofenceExitDetected({
          projectId: record.projectId,
          timeEntryId: record.timeEntryId,
          detectedAt: record.detectedAt,
        });
        await upsertPendingExit({
          pendingExitId: resp.id,
          timeEntryId: record.timeEntryId,
          projectId: record.projectId,
          regionId: record.regionId,
          firesAt: resp.firesAt,
          detectedAt: record.detectedAt,
          // explicit omit of `unsent` — record is now sent
        });
        console.log(
          `[Timesheet] unsent exit retry ok: timeEntryId=${record.timeEntryId} pendingExitId=${resp.id}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(
          `[Timesheet] unsent exit retry failed for ${record.timeEntryId}: ${msg}`,
        );
        // Don't Sentry-capture every retry failure — would spam
        // on a genuine outage. The original POST already
        // captured at the failure source in geofencing.ts.
        // Foreground retries are a recovery path, not a
        // reporting path.
      }
    }
  }, []);

  /**
   * Foreground retry of any unsent enter-detected POSTs. Mirror of
   * retryUnsentExits. Same fire-and-forget discipline, same lack of
   * retry budget / backoff (foreground transitions are user-rate-
   * limited), same lack of per-attempt Sentry capture.
   *
   * Skipped-response handling: if the server responds with
   * { status: "skipped", reason: "already_clocked_in" } during retry,
   * the user clocked in by some other path (manual, or another
   * device) between the original detection and this retry. Drop the
   * unsent record — there's nothing to track.
   */
  const retryUnsentEnters = useCallback(async () => {
    let unsent;
    try {
      unsent = await listUnsentPendingEnters();
    } catch (err) {
      console.log("[Timesheet] unsent-enter list failed:", err);
      return;
    }
    if (unsent.length === 0) return;
    console.log(`[Timesheet] retrying ${unsent.length} unsent enter(s)`);
    for (const record of unsent) {
      try {
        const resp = await api.geofenceEnterDetected({
          projectId: record.projectId,
          regionId: record.regionId,
          detectedAt: record.detectedAt,
        });
        if ("status" in resp && resp.status === "skipped") {
          await removePendingEntersByProjectId(record.projectId);
          console.log(
            `[Timesheet] unsent enter retry skipped by server (${resp.reason}); dropped record for project ${record.projectId}`,
          );
          continue;
        }
        await upsertPendingEnter({
          pendingEnterId: resp.id,
          projectId: record.projectId,
          regionId: record.regionId,
          firesAt: resp.firesAt,
          detectedAt: record.detectedAt,
          // explicit omit of `unsent` — record is now sent
        });
        console.log(
          `[Timesheet] unsent enter retry ok: projectId=${record.projectId} pendingEnterId=${resp.id}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(
          `[Timesheet] unsent enter retry failed for project ${record.projectId}: ${msg}`,
        );
      }
    }
  }, []);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    // Snapshot prev BEFORE the await so the discovery comparison
    // uses the value as of refresh-start, not whatever it might
    // have become during the network round-trip.
    const prevActive = activeRef.current;
    try {
      const next = await api.activeTimesheet();
      const nextActive = next ?? null;

      const prevId = prevActive?.id != null ? String(prevActive.id) : null;
      const nextId = nextActive?.id != null ? String(nextActive.id) : null;

      // ----- Post-fact discovery: exit -----
      //
      // Run when the prior session ended — either no current
      // session (next is null) OR a DIFFERENT session is now
      // current (user manually started a new one between polls).
      // Both cases mean the prev entry is closed and may have
      // been server-fired-out.
      //
      // Two things to do for the closed prev session:
      //   1. Surface the kind="out" receipt ONLY if the closed
      //      entry id matches a local pending-exit record (i.e.
      //      this was a server-fired auto-clock-out, not a
      //      user-initiated clock-out).
      //   2. Always clean up local pending-exit rows for the
      //      closed entry — manual clock-outs leave orphan
      //      unsent rows the server will never accept (entry is
      //      closed), and we don't want the foreground retry to
      //      keep trying.
      const prevSessionEnded = prevActive !== null && nextId !== prevId;
      if (prevSessionEnded && prevId) {
        try {
          const pending = await listPendingExits();
          const match = pending.find((p) => p.timeEntryId === prevId);
          if (match) {
            console.log(
              `[Timesheet] post-fact discovery: server fired auto-clock-out for entry ${prevId} (project ${match.projectId}, firedAt ${match.firesAt})`,
            );
            setFiredExit({ entry: prevActive, firedAt: match.firesAt });
          }
          await removePendingExitByTimeEntryId(prevId);
        } catch (err) {
          // Discovery failure is non-fatal; the user just
          // doesn't see the receipt banner this cycle. Worth
          // Sentry-ing because it indicates either AsyncStorage
          // trouble or a logic bug in pendingExits.
          console.log("[Timesheet] post-fact discovery failed:", err);
          Sentry.captureException(err, {
            extra: { phase: "post-fact-discovery", prevEntryId: prevId },
          });
        }
      }

      // ----- Post-fact discovery: enter -----
      //
      // Symmetric to the exit discovery above. Run when a NEW
      // session is now current that wasn't before (prev was null
      // OR a different id) AND the new session was created with
      // source="auto_geofence". Surface the kind="in" receipt
      // ONLY if the new session's projectId matches a local
      // pending-enter row — that gates against the (rare but
      // principled) case of a session that happens to be tagged
      // auto_geofence but didn't originate from this device's
      // dwell-time POST. Always remove any matching pending-enter
      // rows for the project (the server has now fired; the row
      // would only contribute noise on the next leave event).
      const enterDiscovered =
        nextActive !== null &&
        nextId !== prevId &&
        nextActive.source === "auto_geofence";
      if (enterDiscovered) {
        try {
          const nextProjectId =
            typeof nextActive.projectId === "number"
              ? nextActive.projectId
              : Number(nextActive.projectId);
          const pendingEnters = await listPendingEnters();
          const match = pendingEnters.find(
            (p) => p.projectId === nextProjectId,
          );
          if (match) {
            console.log(
              `[Timesheet] post-fact discovery: server fired auto-clock-in for project ${nextProjectId} (entry ${nextId}, firedAt ${match.firesAt})`,
            );
            setFiredEnter({ entry: nextActive, firedAt: match.firesAt });
            // Remove by id rather than by projectId because there
            // could in principle be a stale row for the same project
            // from a much earlier dwell that never resolved — leave
            // those for the dead-record cleanup. Realistically there
            // is exactly 0 or 1 row per project, so this distinction
            // is academic.
            if (match.pendingEnterId !== null) {
              await removePendingEnterById(match.pendingEnterId);
            } else {
              await removePendingEntersByProjectId(nextProjectId);
            }
          }
        } catch (err) {
          console.log("[Timesheet] post-fact enter discovery failed:", err);
          Sentry.captureException(err, {
            extra: {
              phase: "post-fact-enter-discovery",
              nextEntryId: nextId,
            },
          });
        }
      }

      // ----- Persist last-seen for cold-start coverage -----
      //
      // Write only on session-id transitions, not on every poll
      // (mutations like notes-edits don't affect discovery). On
      // sign-out / clock-out, the key is removed so a stale
      // entry can't bleed into a future cold-launch.
      if (prevId !== nextId) {
        try {
          if (nextActive) {
            await AsyncStorage.setItem(
              LAST_SEEN_KEY,
              JSON.stringify(nextActive),
            );
          } else {
            await AsyncStorage.removeItem(LAST_SEEN_KEY);
          }
        } catch (err) {
          // Non-fatal: cold-start coverage degrades for the next
          // launch, in-session discovery still works fine via
          // activeRef. No Sentry — AsyncStorage failures are
          // device-level and out of our hands.
          console.log("[Timesheet] last-seen persist failed:", err);
        }
      }

      setActive(nextActive);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setActive(null);
      } else {
        console.log("[Timesheet] refresh failed:", e);
      }
    } finally {
      inFlightRef.current = false;
      setReady(true);
    }

    // Fire-and-forget — runs AFTER setReady so it never gates
    // UI. Safe to call when no unsent records exist (cheap
    // AsyncStorage read returns []).
    void retryUnsentExits();
    void retryUnsentEnters();
  }, [retryUnsentExits, retryUnsentEnters]);

  const dismissFiredExit = useCallback(() => {
    setFiredExit(null);
  }, []);

  const dismissFiredEnter = useCallback(() => {
    setFiredEnter(null);
  }, []);

  // Initial fetch once the user is signed in. On the first run
  // for a signed-in user, hydrate activeRef from LAST_SEEN_KEY
  // BEFORE calling refresh, so cold-start can detect server-
  // fired auto-clock-outs that happened while the app was
  // killed.
  useEffect(() => {
    if (!authReady) return;
    if (!user) {
      setActive(null);
      setFiredExit(null);
      setFiredEnter(null);
      setReady(true);
      // Best-effort clear so user-A's pending-fire can't bleed
      // into user-B's session on the same device.
      void AsyncStorage.removeItem(LAST_SEEN_KEY).catch(() => {});
      return;
    }
    void (async () => {
      try {
        const raw = await AsyncStorage.getItem(LAST_SEEN_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as BackendTimesheetEntry;
          // Seed the ref directly. We do NOT setActive(parsed)
          // because the UI shouldn't show stale clocked-in state
          // on cold-launch — the very next refresh call will
          // populate the correct (server-truth) value. The ref
          // is only used internally by the discovery comparison.
          activeRef.current = parsed;
        }
      } catch (err) {
        // Hydration failure degrades to the documented gap:
        // user opens app cold-start after a server-fired
        // clock-out and sees clocked-out state with no banner.
        // They can manually re-clock-in if they want; the
        // 60-min undo window via deep-link / notification still
        // works as a fallback path. Not worth Sentry — most
        // failures here are fresh-install (no key) or cleared-
        // storage (intentional), both expected.
        console.log("[Timesheet] last-seen hydrate failed:", err);
      }
      void refresh();
    })();
  }, [authReady, user, refresh]);

  // Re-sync on foreground.
  //
  // BUILD 13 / Diff 1: also kick the already-inside-on-foreground
  // detector. iOS region monitoring only fires Enter on a boundary
  // CROSSING — if the task was suspended while the user arrived at a
  // site, no Enter ever dispatches. Foreground inside-check closes
  // that gap by polling current location and posting enter-detected
  // for the nearest registered region the device is inside.
  //
  // Active-session guard: read activeRef (not state) to avoid adding
  // a deps cycle on `active`. The inside-check no-ops cleanly when
  // the user is already clocked in.
  useEffect(() => {
    if (!authReady || !user) return;
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void refresh();
        void checkInsideRegisteredGeofences({
          hasActiveTimesheet: activeRef.current != null,
        });
      }
    });
    return () => sub.remove();
  }, [authReady, user, refresh]);

  const clockIn = useCallback(
    async (projectId: string | number, notes?: string) => {
      if (inFlightRef.current) return null;
      inFlightRef.current = true;
      setLoading(true);
      try {
        const entry = await api.clockIn(projectId, notes);
        setActive(entry);
        return entry;
      } catch (e) {
        const msg =
          e instanceof ApiError
            ? e.message
            : e instanceof Error
              ? e.message
              : "Unknown error";
        console.log("[Timesheet] clockIn failed:", e);
        showToast(`Couldn't clock in: ${msg}`);
        return null;
      } finally {
        inFlightRef.current = false;
        setLoading(false);
      }
    },
    [showToast],
  );

  const clockOut = useCallback(
    async (notes?: string) => {
      if (inFlightRef.current) return null;
      inFlightRef.current = true;
      setLoading(true);
      try {
        const entry = await api.clockOut(notes);
        setActive(null);
        showToast("Clocked out");
        return entry;
      } catch (e) {
        const msg =
          e instanceof ApiError
            ? e.message
            : e instanceof Error
              ? e.message
              : "Unknown error";
        console.log("[Timesheet] clockOut failed:", e);
        showToast(`Couldn't clock out: ${msg}`);
        return null;
      } finally {
        inFlightRef.current = false;
        setLoading(false);
      }
    },
    [showToast],
  );

  const value = useMemo<TimesheetState>(
    () => ({
      active,
      ready,
      loading,
      refresh,
      clockIn,
      clockOut,
      firedExit,
      dismissFiredExit,
      setFiredExit,
      firedEnter,
      dismissFiredEnter,
      setFiredEnter,
    }),
    [
      active,
      ready,
      loading,
      refresh,
      clockIn,
      clockOut,
      firedExit,
      dismissFiredExit,
      setFiredExit,
      firedEnter,
      dismissFiredEnter,
      setFiredEnter,
    ],
  );

  return (
    <TimesheetContext.Provider value={value}>
      {children}
    </TimesheetContext.Provider>
  );
}

export function useTimesheet(): TimesheetState {
  const ctx = useContext(TimesheetContext);
  if (!ctx)
    throw new Error("useTimesheet must be used inside TimesheetProvider");
  return ctx;
}
