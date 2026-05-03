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
}

const TimesheetContext = createContext<TimesheetState | undefined>(undefined);

export function TimesheetProvider({ children }: { children: React.ReactNode }) {
  const { user, ready: authReady } = useAuth();
  const { showToast } = useToast();
  const [active, setActive] = useState<BackendTimesheetEntry | null>(null);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [firedExit, setFiredExit] = useState<FiredExit | null>(null);

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

      // ----- Post-fact discovery -----
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
  }, [retryUnsentExits]);

  const dismissFiredExit = useCallback(() => {
    setFiredExit(null);
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
  useEffect(() => {
    if (!authReady || !user) return;
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
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
