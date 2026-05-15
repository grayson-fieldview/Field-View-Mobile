import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Local persistence of pending geofence-enter rows tracked server-side
 * by S3x-web's POST /api/geofence/enter-detected (dwell-time auto-
 * clock-in). Sibling to services/pendingExits.ts — same shape, same
 * lifecycle, same storage discipline. Used for:
 *
 *   1. **Cancel-on-leave** — when the OS fires Exit for a region we've
 *      recently posted an enter for (user stepped onto the site, then
 *      walked back off before the dwell window elapsed), mobile POSTs
 *      /api/geofence/enter-cancelled with the stored `pendingEnterId`
 *      so the server drops the pending row before its cron fires the
 *      auto-clock-in. Net effect: brief presence, no DB churn, no
 *      surprise time entry.
 *
 *   2. **Post-facto receipt discovery** — TimesheetContext's foreground
 *      refresh diffs `active` against the prior value; if `active`
 *      transitioned from null → an `auto_geofence` session AND the
 *      new entry's projectId matches a local pending-enter row, the
 *      server fired the clock-in. Mobile surfaces the receipt banner
 *      with kind="in" and removes the pending row.
 *
 *   3. **Unsent retry** — if POST enter-detected failed at observation
 *      time (network drop, 5xx), we persist the row with `unsent: true`
 *      and retry on next foreground. The `pendingEnterId` is null in
 *      this state — there's no server-side row to cancel — but a
 *      cancel-on-leave is still possible and handled by removing the
 *      local record without an enter-cancelled call.
 *
 * Storage layer: plain AsyncStorage. Mirrors services/pendingExits.ts
 * load-all → mutate-all → save-all pattern. Pending enter IDs are NOT
 * sensitive (they're opaque server-issued tokens scoped to a single
 * pending row, not credentials), so SecureStore is unnecessary
 * overhead.
 *
 * No subscribers / reactive surface: callers read on demand from
 * geofencing.ts and TimesheetContext.tsx. Adding pub/sub for a
 * collection that mutates ≤ once per geofence event would be
 * complexity without payoff.
 *
 * Compound key for upsert is (projectId, regionId) rather than the
 * exits' (timeEntryId, regionId): there's no active session at
 * enter-detect time, so timeEntryId doesn't exist yet. projectId +
 * regionId is the natural identity; in practice regionId already
 * encodes projectId, but keeping both defends against a future
 * region-rename without breaking dedup.
 */

const STORAGE_KEY = "@fv/pending_enters_v1";

/**
 * Records older than this past their `firesAt` are considered dead.
 * Mirrors pendingExits.ts: once the dwell window has long passed, a
 * stale local row only causes noise. The 60-min cushion is the same
 * as exits and matches the auto-undo window so we don't prematurely
 * drop a row a user might still want to undo.
 */
const DEAD_AFTER_FIRES_MS = 60 * 60_000;

export interface PendingEnterRecord {
  /**
   * Server-issued UUID for the pending enter row. `null` ONLY in the
   * unsent-retry state where the initial POST enter-detected failed
   * before the server could issue an id. Cancel-on-leave MUST gate
   * on a non-null value before posting enter-cancelled.
   */
  pendingEnterId: string | null;
  /** The project the user entered. No timeEntryId — no active session yet. */
  projectId: number;
  /** e.g. "fv-project-v2-42" — used to look up by region from the Exit handler. */
  regionId: string;
  /**
   * ISO timestamp when the server WILL fire the auto-clock-in.
   * Surfaced in API response from POST /api/geofence/enter-detected.
   * Used for the dead-record cleanup threshold here AND as the
   * `firedAt` timestamp on the post-facto FiredEnter receipt banner.
   */
  firesAt: string;
  /** ISO timestamp when mobile observed the OS enter event. */
  detectedAt: string;
  /**
   * True if the initial POST enter-detected failed and we're holding
   * the row for retry on next foreground. `pendingEnterId` is null in
   * this state.
   */
  unsent?: boolean;
}

// ---- Module state ----
//
// Mirrors pendingExits' pattern: in-memory snapshot + lazy-load on
// first access. AsyncStorage hits are async + measurable, so the
// load is gated behind a single `loadPromise` to avoid concurrent
// reads racing each other on the first call after cold-launch.

let records: PendingEnterRecord[] = [];
let loaded = false;
let loadPromise: Promise<void> | null = null;

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as PendingEnterRecord[];
        records = Array.isArray(parsed) ? parsed : [];
      }
    } catch (e) {
      console.log("[pending-enters] failed to load persisted records:", e);
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
    // pending enter to "post-facto receipt only" (worst case: the
    // user sees the auto-clock-in happen with no Undo). Acceptable
    // failure mode.
    console.log("[pending-enters] persist failed:", e);
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
 * Load + return all pending enter records, with passive cleanup of
 * dead rows applied. The returned array is a snapshot — mutating it
 * does not affect storage.
 */
export async function listPendingEnters(): Promise<PendingEnterRecord[]> {
  await ensureLoaded();
  if (pruneDead()) {
    console.log("[pending-enters] pruned dead records during list");
    await persist();
  }
  return [...records];
}

/**
 * Insert or replace by the compound key (projectId, regionId). See
 * the file-level docstring for why this key (and not just regionId).
 */
export async function upsertPendingEnter(
  record: PendingEnterRecord,
): Promise<void> {
  await ensureLoaded();
  const idx = records.findIndex(
    (r) => r.projectId === record.projectId && r.regionId === record.regionId,
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

export async function removePendingEnterById(
  pendingEnterId: string,
): Promise<void> {
  await ensureLoaded();
  const before = records.length;
  records = records.filter((r) => r.pendingEnterId !== pendingEnterId);
  if (records.length !== before) await persist();
}

/**
 * Used by TimesheetContext post-facto discovery once the server has
 * fired and a fresh `auto_geofence` session became active for this
 * project. Removes any pending-enter rows for the project — there's
 * never more than one in steady state, but loop-safe by design.
 */
export async function removePendingEntersByProjectId(
  projectId: number,
): Promise<void> {
  await ensureLoaded();
  const before = records.length;
  records = records.filter((r) => r.projectId !== projectId);
  if (records.length !== before) await persist();
}

/**
 * Used by the Exit-side cancel hook in geofencing.ts when the matched
 * record has `pendingEnterId === null` (unsent retry state), so
 * removePendingEnterById has no key to use.
 */
export async function removePendingEnterByCompoundKey(
  projectId: number,
  regionId: string,
): Promise<void> {
  await ensureLoaded();
  const before = records.length;
  records = records.filter(
    (r) => !(r.projectId === projectId && r.regionId === regionId),
  );
  if (records.length !== before) await persist();
}

/**
 * Used by the Exit handler to decide whether the new event is
 * actually a leave-during-dwell on a recently-posted enter. Returns
 * ALL matching records — the caller is expected to attempt cancel on
 * each (or just the first; in practice this is 0 or 1).
 */
export async function findPendingEntersForRegion(
  regionId: string,
): Promise<PendingEnterRecord[]> {
  await ensureLoaded();
  return records.filter((r) => r.regionId === regionId);
}

/**
 * Foreground retry surface. Returns rows whose initial POST
 * enter-detected failed, so the caller can re-attempt and either
 * fill in `pendingEnterId` + clear `unsent`, drop the row when the
 * server returns "skipped: already_clocked_in", or leave the row
 * for the next foreground.
 */
export async function listUnsentPendingEnters(): Promise<PendingEnterRecord[]> {
  await ensureLoaded();
  return records.filter((r) => r.unsent === true);
}

/**
 * Test-only helper. Wipes both in-memory and persisted state.
 * Not for production use — intended for unit tests + the dev
 * profile screen if a "clear pending enters" affordance is added.
 */
export async function _resetForTesting(): Promise<void> {
  records = [];
  loaded = true;
  loadPromise = null;
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    console.log("[pending-enters] reset failed:", e);
  }
}
