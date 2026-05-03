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
 * Surfaced when the foreground refresh observes that a previously-
 * active entry has become null AND we have a local pending-exit
 * record matching that entry id. Indicates the server's auto-clock-
 * out cron fired while we weren't looking — the project detail
 * screen consumes this to render a kind="out" receipt banner with
 * an Undo affordance.
 *
 * `entry` is the LAST-KNOWN active entry (the prev value, captured
 * before refresh observed null). It carries the original projectId,
 * clockIn, AND — once the server has populated it — clockOut.
 * Consumers should defensively gate on `entry.clockOut != null`
 * before formatting the time label.
 */
export interface FiredExit {
  entry: BackendTimesheetEntry;
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
   * Non-null when the foreground refresh discovered a server-fired
   * auto-clock-out. Cleared by `dismissFiredExit` (called by the
   * receipt banner on user X tap or after a successful Undo).
   * Multiple fires across sessions are at-most-one — the second
   * overwrites the first, which is acceptable because clock-out
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

  // Single in-flight guard shared by refresh AND mutations so a background
  // foreground-refresh can't race with (and clobber) an optimistic clockIn /
  // clockOut result.
  const inFlightRef = useRef(false);

  // Mirror of `active` for use inside async callbacks whose useCallback
  // deps shouldn't include `active` (we don't want refresh's identity
  // to thrash on every poll). Read at the START of refresh as the
  // "previous" value to compare against the freshly-fetched one.
  // Updated via the effect below — always one render behind state,
  // which is exactly what we want as "prev".
  const activeRef = useRef<BackendTimesheetEntry | null>(null);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  /**
   * Foreground retry of any unsent exit-detected POSTs. Fire-and-
   * forget — does not block setReady or UI gating. Each unsent
   * record gets one POST attempt; on success we upsert with the
   * real server id+firesAt and clear `unsent`, on failure the
   * record is left alone for the next foreground.
   *
   * No retry budget / backoff: AppState foreground transitions are
   * naturally rate-limited (user has to background and reopen the
   * app), and the dead-record cleanup in pendingExits.ts eventually
   * prunes records whose firesAt-estimate has long passed (60min
   * post-estimate). If the server is genuinely unreachable for that
   * long, the unsent record times out without further harm.
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
        // Don't Sentry-capture every retry failure — would spam on a
        // genuine outage. The original POST already captured at the
        // failure source in geofencing.ts. Foreground retries are a
        // recovery path, not a reporting path.
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

      // ----- Post-fact discovery -----
      //
      // If we just observed a non-null → null transition, the
      // session ended somehow (manual clock-out, server-fired
      // auto-clock-out, or admin edit). Two things to do:
      //   1. Surface the kind="out" receipt ONLY if the closed
      //      entry id matches a local pending-exit record (i.e.
      //      this was a server-fired auto-clock-out).
      //   2. Always clean up local pending-exit rows for the
      //      closed entry — manual clock-outs leave orphan unsent
      //      rows the server will never accept (entry is closed),
      //      and we don't want the foreground retry to keep trying.
      if (prevActive !== null && nextActive === null) {
        const prevId = String(prevActive.id);
        try {
          const pending = await listPendingExits();
          const match = pending.find((p) => p.timeEntryId === prevId);
          if (match) {
            console.log(
              `[Timesheet] post-fact discovery: server fired auto-clock-out for entry ${prevId} (project ${match.projectId})`,
            );
            setFiredExit({ entry: prevActive });
          }
          await removePendingExitByTimeEntryId(prevId);
        } catch (err) {
          // Discovery failure is non-fatal; the user just doesn't
          // see the receipt banner this cycle. Worth Sentry-ing
          // because it indicates either AsyncStorage trouble or
          // a logic bug in pendingExits.
          console.log("[Timesheet] post-fact discovery failed:", err);
          Sentry.captureException(err, {
            extra: { phase: "post-fact-discovery", prevEntryId: prevId },
          });
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

    // Fire-and-forget — runs AFTER setReady so it never gates UI.
    // Safe to call when no unsent records exist (cheap AsyncStorage
    // read returns []).
    void retryUnsentExits();
  }, [retryUnsentExits]);

  const dismissFiredExit = useCallback(() => {
    setFiredExit(null);
  }, []);

  // Initial fetch once the user is signed in.
  useEffect(() => {
    if (!authReady) return;
    if (!user) {
      setActive(null);
      setFiredExit(null);
      setReady(true);
      return;
    }
    void refresh();
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
