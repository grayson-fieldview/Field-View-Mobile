import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Local persistence of pending geofence-exit rows tracked server-side
 * by S32a-web's POST /api/geofence/exit-detected. Used for:
 *
 *   1. **Cancel-on-re-enter** — when the OS fires Enter for a region
 *      we've recently posted an exit for, mobile POSTs
 *      /api/geofence/exit-cancelled with the stored `pendingExitId`
 *      so the server drops the pending row before the cron fires it.
 *      Net effect: user briefly stepped outside, came back, no DB
 *      churn, session continues.
 *
 *   2. **Post-facto receipt discovery** — TimesheetContext's
 *      foreground refresh diffs `active` against the prior value;
 *      if a previously-active entry id matches a pending exit row
 *      AND `active` is now null, the server fired the exit. Mobile
 *      surfaces the receipt banner with kind="out" and removes the
 *      pending row.
 *
 *   3. **Unsent retry** — if POST exit-detected failed at exit
 *      observation time (network drop, 5xx), we persist the row with
 *      `unsent: true` and retry on next foreground. The
 *      `pendingExitId` is null in this state — there's no server-side
 *      row to cancel — but a re-enter is still possible and handled
 *      by removing the local record without an exit-cancelled call.
 *
 * Storage layer: plain AsyncStorage. Mirrors services/uploadQueue.ts
 * load-all → mutate-all → save-all pattern. Pending exit IDs are NOT
 * sensitive (they're opaque server-issued tokens scoped to a single
 * pending row, not credentials), so SecureStore is unnecessary
 * overhead.
 *
 * No subscribers / reactive surface: callers read on demand from
 * geofencing.ts and TimesheetContext.tsx. Adding pub/sub for a
 * collection that mutates ≤ once per geofence event would be
 * complexity without payoff.
 */

const STORAGE_KEY = "@fv/pending_exits_v1";

/**
 * Records older than this past their `firesAt` are considered dead:
 * the server's auto-undo window (60 min from clock-out per S31b
 * web spec) has expired, so neither a re-enter cancel nor a post-
 * facto receipt is useful any more. Passive cleanup runs inside
 * listPendingExits — see comment there.
 */
const DEAD_AFTER_FIRES_MS = 60 * 60_000;

export interface PendingExitRecord {
  /**
   * Server-issued UUID for the pending exit row. `null` ONLY in the
   * unsent-retry state where the initial POST exit-detected failed
   * before the server could issue an id. Cancel-on-re-enter MUST
   * gate on a non-null value before posting exit-cancelled.
   */
  pendingExitId: string | null;
  /** The active timesheet entry id at the time of exit observation. */
  timeEntryId: string;
  projectId: number;
  /** e.g. "fv-project-42" — used to look up by region from the Enter handler. */
  regionId: string;
  /**
   * ISO timestamp when the server WILL fire the auto-clock-out.
   * Surfaced in API response from POST /api/geofence/exit-detected.
   * Used for the watchdog timeout in geofencing.ts AND the dead-
   * record cleanup threshold here.
   */
  firesAt: string;
  /** ISO timestamp when mobile observed the OS exit event. */
  detectedAt: string;
  /**
   * True if the initial POST exit-detected failed and we're holding
   * the row for retry on next foreground. `pendingExitId` is null in
   * this state.
   */
  unsent?: boolean;
}

// ---- Module state ----
//
// Mirrors uploadQueue's pattern: in-memory snapshot + lazy-load on
// first access. AsyncStorage hits are async + measurable, so the
// load is gated behind a single `loadPromise` to avoid concurrent
// reads racing each other on the first call after cold-launch.

let records: PendingExitRecord[] = [];
let loaded = false;
let loadPromise: Promise<void> | null = null;

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as PendingExitRecord[];
        records = Array.isArray(parsed) ? parsed : [];
      }
    } catch (e) {
      console.log("[pending-exits] failed to load persisted records:", e);
      records = [];
    } finally {
      loaded = true;
    }
  })();
  return loadPromise;
}

async function persist(): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch (e) {
    // Persistence failures are logged but NOT thrown — the in-memory
    // copy is still authoritative for the current process. The risk
    // is losing the row on next process restart, which downgrades a
    // pending exit to "post-facto receipt only" (worst case: the
    // user sees the auto-clock-out happen with no Undo). Acceptable
    // failure mode.
    console.log("[pending-exits] persist failed:", e);
  }
}

/**
 * Drop records whose firesAt + DEAD_AFTER_FIRES_MS has passed.
 * Returns true if anything was dropped. Caller is responsible for
 * persisting.
 */
function pruneDead(): boolean {
  const cutoff = Date.now() - DEAD_AFTER_FIRES_MS;
  const before = records.length;
  records = records.filter((r) => {
    const firesAtMs = Date.parse(r.firesAt);
    if (!Number.isFinite(firesAtMs)) return true; // keep malformed; let caller decide
    return firesAtMs >= cutoff;
  });
  return records.length !== before;
}

// ---- Public API ----

/**
 * Load + return all pending exit records, with passive cleanup of
 * dead rows applied. The returned array is a snapshot — mutating it
 * does not affect storage.
 */
export async function listPendingExits(): Promise<PendingExitRecord[]> {
  await ensureLoaded();
  if (pruneDead()) {
    console.log("[pending-exits] pruned dead records during list");
    await persist();
  }
  return [...records];
}

/**
 * Insert or replace by the compound key (timeEntryId, regionId).
 *
 * Why that key: a single time entry can in principle have multiple
 * pending exits if the user crosses multiple region boundaries
 * before the server fires (e.g. nested geofences or registration
 * boundary jitter). Keying on timeEntryId alone would clobber one
 * with the other. Keying on regionId alone would mix exits for
 * different sessions. The compound key is the natural identity.
 */
export async function upsertPendingExit(
  record: PendingExitRecord,
): Promise<void> {
  await ensureLoaded();
  const idx = records.findIndex(
    (r) =>
      r.timeEntryId === record.timeEntryId && r.regionId === record.regionId,
  );
  if (idx === -1) {
    records = [...records, record];
  } else {
    const next = [...records];
    next[idx] = record;
    records = next;
  }
  await persist();
}

export async function removePendingExitById(
  pendingExitId: string,
): Promise<void> {
  await ensureLoaded();
  const before = records.length;
  records = records.filter((r) => r.pendingExitId !== pendingExitId);
  if (records.length !== before) await persist();
}

/**
 * Used by TimesheetContext post-facto discovery once the server has
 * fired and the local active entry transitioned to null.
 */
export async function removePendingExitByTimeEntryId(
  timeEntryId: string,
): Promise<void> {
  await ensureLoaded();
  const before = records.length;
  records = records.filter((r) => r.timeEntryId !== timeEntryId);
  if (records.length !== before) await persist();
}

/**
 * Used by the Enter handler to decide whether the new event is
 * actually a re-enter on a debounced exit. Returns ALL matching
 * records — the caller is expected to attempt cancel on each (or
 * just the first; in practice this is 0 or 1).
 */
export async function findPendingExitsForRegion(
  regionId: string,
): Promise<PendingExitRecord[]> {
  await ensureLoaded();
  return records.filter((r) => r.regionId === regionId);
}

/**
 * Foreground retry surface. Returns rows whose initial POST
 * exit-detected failed, so the caller can re-attempt and either
 * fill in `pendingExitId` + clear `unsent`, or leave the row for
 * the next foreground.
 */
export async function listUnsentPendingExits(): Promise<PendingExitRecord[]> {
  await ensureLoaded();
  return records.filter((r) => r.unsent === true);
}

/**
 * Test-only helper. Wipes both in-memory and persisted state.
 * Not for production use — intended for unit tests + the dev
 * profile screen if a "clear pending exits" affordance is added.
 */
export async function _resetForTesting(): Promise<void> {
  records = [];
  loaded = true;
  loadPromise = null;
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    console.log("[pending-exits] reset failed:", e);
  }
}
