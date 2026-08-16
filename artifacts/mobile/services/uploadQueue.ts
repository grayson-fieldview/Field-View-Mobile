import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import * as FileSystem from "expo-file-system/legacy";

import {
  ApiError,
  api,
  UploadExpiredError,
  type BackendChecklistItemPhoto,
  type BackendTaskPhoto,
} from "./api";
import { newId } from "./id";
import { pendingUploadsDir } from "./imageProcessing";
import { Sentry } from "./sentry";

const STORAGE_KEY = "@fv/upload_queue";
const TICK_MS = 2_000;
const PERSIST_DEBOUNCE_MS = 100;
const MAX_CONCURRENT = 3;

const BACKOFF_MS: number[] = [
  1_000,            // attempt 1 → 1s
  5_000,            // attempt 2 → 5s
  30_000,           // attempt 3 → 30s
  5 * 60_000,       // attempt 4 → 5min
  30 * 60_000,      // attempt 5 → 30min
  2 * 60 * 60_000,  // attempt 6 → 2hr
];
const FALLBACK_BACKOFF_MS = 6 * 60 * 60_000; // every 6hr after that, forever

export interface QueuedUpload {
  id: string;
  localUri: string;
  projectId: string;
  originalName: string;
  mimeType: string;
  fileSize: number;
  latitude?: number;
  longitude?: number;
  /**
   * Capture time, strict ISO 8601 (new Date().toISOString() at capture).
   * Persists in AsyncStorage with the rest of the item — a photo taken
   * offline and uploaded days later must still carry its original
   * capture time. Optional: items queued before this field existed (or
   * paths that don't stamp it) upload without it and the server stores
   * null. Passed through to createMedia UNCHANGED — never reformat.
   */
  takenAt?: string;
  /**
   * Optional checklist-item attach target. When set, the post-upload tagger
   * (see processItem) calls api.attachPhotoToItem(checklistItemId, mediaId)
   * after the Media row is created. Errors there are logged but do not fail
   * the upload — the photo still lands on the project.
   */
  checklistItemId?: string;
  /**
   * Optional task attach target — mirror of checklistItemId. When set,
   * the post-upload tagger calls api.attachPhotosToTask(taskId,
   * [mediaId]) after the Media row is created (same retry ladder).
   * Errors are surfaced via subscribeTaskAttach but do not fail the
   * upload — the photo still lands on the project.
   */
  taskId?: string;
  /**
   * "uploaded_pending_attach" = the bytes are on S3 and the Media row
   * exists, but the item carries an attach target (checklistItemId /
   * taskId) whose join-row POST hasn't succeeded yet. The record stays
   * in the queue (and persists across relaunches) so the tick loop can
   * resume the attach, exactly like it resumes uploads. Only when the
   * attach succeeds — or terminally fails after MAX_ATTACH_ROUNDS —
   * does the item become "uploaded".
   *
   * "unrecoverable" = the local file no longer exists on device (iOS
   * evicted it, or a legacy cache-dir item's bytes were purged before
   * the documentDirectory migration). Excluded from all retry/backoff
   * processing — the only valid user action is Remove.
   */
  status:
    | "pending"
    | "uploading"
    | "uploaded"
    | "uploaded_pending_attach"
    | "failed"
    | "unrecoverable";
  attemptCount: number;
  /**
   * Attach-step retry rounds consumed (each round = one in-memory
   * [0,2s,8s] ladder). Persisted so relaunches resume the count instead
   * of restarting it — the terminal-failure alert must fire exactly
   * once, not on every launch.
   */
  attachAttemptCount?: number;
  /** Per-target success flags so an idempotent re-run after a partial
   *  round (or relaunch) doesn't re-emit success events. */
  checklistAttached?: boolean;
  taskAttached?: boolean;
  nextRetryAt?: number;
  lastError?: string;
  /**
   * HTTP status of the last failure when it was an ApiError (0 = network
   * / local-file read failure). Used by the failed-upload UIs to
   * distinguish auth (401) from network failures.
   */
  lastErrorStatus?: number;
  createdAt: number;
  uploadedMediaId?: number;
  uploadedUrl?: string;
}

export type EnqueueInput = Omit<
  QueuedUpload,
  "id" | "status" | "attemptCount" | "createdAt"
>;

type Listener = (queue: QueuedUpload[]) => void;

/**
 * Result of the post-upload checklist-item attach step. Emitted exactly
 * once per upload that carried a `checklistItemId`, after the attach
 * settles (success OR final failure following retries). Subscribers can
 * use this to update their UI immediately without polling — the success
 * payload includes the server-issued junction row, so a refetch is not
 * required on the happy path.
 */
export interface ChecklistAttachEvent {
  checklistItemId: string;
  mediaId: number;
  /** Present on success — the new junction row. */
  photo?: BackendChecklistItemPhoto;
  /** Present on failure — human-readable message. */
  error?: string;
}
type AttachListener = (event: ChecklistAttachEvent) => void;

/**
 * Result of the post-upload TASK attach step — mirror of
 * ChecklistAttachEvent. Emitted exactly once per upload that carried a
 * `taskId`, after the attach settles (success OR final failure after
 * retries). DataContext subscribes to reconcile the task's
 * attachedPhotoCount and surface terminal failures; the photos sheet
 * subscribes to refresh its grid.
 */
export interface TaskAttachEvent {
  taskId: string;
  mediaId: number;
  /** Present on success — the new task_photos junction row. */
  photo?: BackendTaskPhoto;
  /** Present on failure — human-readable message. */
  error?: string;
}
type TaskAttachListener = (event: TaskAttachEvent) => void;

// ---- Module state ----
let queue: QueuedUpload[] = [];
let loaded = false;
let loadPromise: Promise<void> | null = null;
const subscribers = new Set<Listener>();
const attachSubscribers = new Set<AttachListener>();
const taskAttachSubscribers = new Set<TaskAttachListener>();
const inFlight = new Set<string>();
let tickInterval: ReturnType<typeof setInterval> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let netUnsub: (() => void) | null = null;
let lastConnected: boolean | null = null;

// ---- Helpers ----
function backoffDelay(attemptCount: number): number {
  if (attemptCount < 1) return BACKOFF_MS[0];
  const idx = Math.min(attemptCount - 1, BACKOFF_MS.length - 1);
  return BACKOFF_MS[idx] ?? FALLBACK_BACKOFF_MS;
}

const UNRECOVERABLE_MESSAGE = "Photo no longer on device";

/** True when the uri points at a local file we can inspect/delete. */
function isLocalFileUri(uri: string): boolean {
  return uri.startsWith("file:");
}

/** Best-effort local file existence check. `null` = couldn't determine. */
async function localFileExists(uri: string): Promise<boolean | null> {
  if (!isLocalFileUri(uri)) return null;
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists === true;
  } catch {
    // Can't determine — do NOT treat as missing (never false-positive
    // an unrecoverable transition on an FS hiccup).
    return null;
  }
}

/** Best-effort delete of a pending local file (post-upload / on remove). */
async function deleteLocalFile(uri: string): Promise<void> {
  if (!isLocalFileUri(uri)) return;
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch (e) {
    console.log(`[upload-queue] failed to delete local file ${uri}:`, e);
  }
}

/**
 * Telemetry for every transition into "unrecoverable" — this is the field
 * data the eviction diagnosis flagged as missing. `source` says whether the
 * bytes were already gone at migration time ("migration") or vanished under
 * a live queue ("eviction").
 */
function reportUnrecoverable(
  item: QueuedUpload,
  source: "migration" | "eviction",
): void {
  console.log(
    `[upload-queue] item ${item.id} (${item.originalName}) is unrecoverable (${source})`,
  );
  Sentry.captureMessage("upload-queue: item unrecoverable (local file gone)", {
    level: "warning",
    extra: { source, attemptCount: item.attemptCount },
  });
}

/**
 * One-time per-item migration of legacy cache-directory items into the
 * stable pending dir, plus an orphan-file sweep. Runs inside ensureLoaded
 * after the queue is parsed. Native only (no-op when pendingUploadsDir()
 * is null, i.e. web).
 */
async function migrateAndSweep(): Promise<void> {
  const dir = pendingUploadsDir();
  if (!dir) return;
  try {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(
      () => {
        /* already exists */
      },
    );

    let changed = false;
    const migrated: QueuedUpload[] = [];
    for (const it of queue) {
      // States whose bytes are already on S3 (or gone for good) keep
      // their record as-is. "uploaded_pending_attach" belongs here: its
      // local file was already deleted after media-create, so the
      // missing-file check below must never mark it unrecoverable.
      if (
        it.status === "uploaded" ||
        it.status === "uploaded_pending_attach" ||
        it.status === "unrecoverable"
      ) {
        migrated.push(it);
        continue;
      }
      if (!isLocalFileUri(it.localUri) || it.localUri.startsWith(dir)) {
        migrated.push(it);
        continue;
      }
      // Legacy item pointing outside pending/ (old cacheDirectory path).
      const exists = await localFileExists(it.localUri);
      if (exists === false) {
        const next: QueuedUpload = {
          ...it,
          status: "unrecoverable",
          lastError: UNRECOVERABLE_MESSAGE,
          nextRetryAt: undefined,
        };
        reportUnrecoverable(next, "migration");
        migrated.push(next);
        changed = true;
        continue;
      }
      if (exists === true) {
        const name = it.localUri.slice(it.localUri.lastIndexOf("/") + 1);
        const dest = `${dir}${name}`;
        try {
          await FileSystem.moveAsync({ from: it.localUri, to: dest });
          console.log(
            `[upload-queue] migrated ${it.id} to stable storage: ${dest}`,
          );
          migrated.push({ ...it, localUri: dest });
          changed = true;
          continue;
        } catch (e) {
          console.log(`[upload-queue] migration move failed for ${it.id}:`, e);
        }
      }
      // exists === null (indeterminate) or move failed: leave untouched;
      // the pre-attempt existence check will settle it later.
      migrated.push(it);
    }
    if (changed) queue = migrated;

    // Orphan sweep: delete files in pending/ that no queue item references
    // (crash between file copy and enqueue, or persist race on kill).
    const referenced = new Set(
      queue.map((it) => it.localUri.slice(it.localUri.lastIndexOf("/") + 1)),
    );
    const names = await FileSystem.readDirectoryAsync(dir).catch(
      () => [] as string[],
    );
    for (const name of names) {
      if (!referenced.has(name)) {
        console.log(`[upload-queue] sweeping orphan pending file: ${name}`);
        await deleteLocalFile(`${dir}${name}`);
      }
    }
    if (changed) schedulePersist();
  } catch (e) {
    // Never block queue startup on migration/sweep problems.
    console.log("[upload-queue] migrateAndSweep failed:", e);
  }
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as QueuedUpload[];
        const now = Date.now();
        // Crash recovery: reset any "uploading" items to "failed" with
        // immediate retry — otherwise they orphan-stuck after a kill.
        queue = parsed.map((it) =>
          it.status === "uploading"
            ? {
                ...it,
                status: "failed",
                nextRetryAt: now,
                lastError: "Restored after restart",
              }
            : it,
        );
      }
      // Move legacy cache-dir items into stable storage, flag items whose
      // bytes are already gone, and sweep orphaned pending files.
      await migrateAndSweep();
    } catch (e) {
      console.log("[upload-queue] failed to load persisted queue:", e);
      queue = [];
    } finally {
      loaded = true;
    }
  })();
  return loadPromise;
}

function notifySubscribers(): void {
  const snapshot = [...queue];
  for (const fn of subscribers) {
    try {
      fn(snapshot);
    } catch (e) {
      console.log("[upload-queue] subscriber threw:", e);
    }
  }
}

function emitAttach(event: ChecklistAttachEvent): void {
  for (const fn of attachSubscribers) {
    try {
      fn(event);
    } catch (e) {
      console.log("[upload-queue] attach subscriber threw:", e);
    }
  }
}

function emitTaskAttach(event: TaskAttachEvent): void {
  for (const fn of taskAttachSubscribers) {
    try {
      fn(event);
    } catch (e) {
      console.log("[upload-queue] task attach subscriber threw:", e);
    }
  }
}

const ATTACH_RETRY_DELAYS_MS = [0, 2_000, 8_000];
/**
 * Max attach ROUNDS per item. One round = one in-memory [0,2s,8s]
 * ladder (3 HTTP attempts), run inside a single processing pass.
 * Rounds are persisted (attachAttemptCount) so backoff — and the
 * exactly-once terminal alert — survive app relaunches. 3 rounds =
 * up to 9 attempts total, spread across tick backoff / relaunches.
 */
const MAX_ATTACH_ROUNDS = 3;

/**
 * One retry-ladder round of POST /api/tasks/:taskId/photos with the new
 * mediaId. Idempotent server-side per (task, media), so re-attempting
 * an attach that already landed (ambiguous failure, relaunch) is
 * harmless. Emits the SUCCESS event itself; returns false on round
 * failure — the caller (processAttach) owns round accounting and the
 * exactly-once terminal error event.
 */
async function attachTaskRound(
  taskId: string,
  mediaId: number,
  uploadedUrl?: string,
): Promise<boolean> {
  let lastErr: unknown;
  for (let i = 0; i < ATTACH_RETRY_DELAYS_MS.length; i++) {
    const delay = ATTACH_RETRY_DELAYS_MS[i] ?? 0;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    try {
      const res = await api.attachPhotosToTask(taskId, [mediaId]);
      let photo: BackendTaskPhoto | undefined = Array.isArray(res)
        ? res[0]
        : res;
      // Patch a missing joined-media url from the uploaded URL so
      // subscribers can render the thumbnail without a refetch (same
      // tolerance as the checklist path).
      const hasUrl =
        typeof photo?.media?.url === "string" &&
        photo.media.url.trim().length > 0;
      const fallback =
        typeof uploadedUrl === "string" && uploadedUrl.trim().length > 0
          ? uploadedUrl
          : undefined;
      if (photo && !hasUrl && fallback) {
        photo = { ...photo, media: { ...photo.media, url: fallback } };
      }
      console.log(
        `[upload-queue] ✓ attached media ${mediaId} → task ${taskId} (attempt ${i + 1})`,
      );
      emitTaskAttach({ taskId, mediaId, photo });
      return true;
    } catch (e) {
      lastErr = e;
      console.log(
        `[upload-queue] task attach attempt ${i + 1} failed for media ${mediaId} → task ${taskId}:`,
        e,
      );
    }
  }
  void lastErr;
  return false;
}

/**
 * One retry-ladder round of the checklist attach. Same contract as
 * attachTaskRound: emits success itself, returns false on round
 * failure, terminal error events are owned by processAttach.
 */
async function attachChecklistRound(
  checklistItemId: string,
  mediaId: number,
  uploadedUrl?: string,
): Promise<boolean> {
  let lastErr: unknown;
  for (let i = 0; i < ATTACH_RETRY_DELAYS_MS.length; i++) {
    const delay = ATTACH_RETRY_DELAYS_MS[i] ?? 0;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    try {
      let photo = await api.attachPhotoToItem(checklistItemId, mediaId);
      // Server's bulk-attach response may omit the joined media `url`.
      // Patch from the uploaded URL we already have so the thumbnail
      // renders immediately without a separate listChecklistItemPhotos
      // round-trip. See TECH_DEBT.md: "Server-side checklist-item-photo
      // attach response should include joined media url".
      // Treat empty string as missing — server may send `url: ""`
      // rather than omit the field entirely.
      const hasUrl =
        typeof photo.url === "string" && photo.url.trim().length > 0;
      const fallback =
        typeof uploadedUrl === "string" && uploadedUrl.trim().length > 0
          ? uploadedUrl
          : undefined;
      if (!hasUrl && fallback) {
        photo = { ...photo, url: fallback };
      }
      console.log(
        `[upload-queue] ✓ attached media ${mediaId} → item ${checklistItemId} (attempt ${i + 1})`,
      );
      emitAttach({ checklistItemId, mediaId, photo });
      return true;
    } catch (e) {
      lastErr = e;
      console.log(
        `[upload-queue] attach attempt ${i + 1} failed for media ${mediaId} → item ${checklistItemId}:`,
        e,
      );
    }
  }
  void lastErr;
  return false;
}

/**
 * Persisted post-upload attach step. Runs one round of each still-
 * unattached target (checklist item and/or task), then settles the
 * item:
 * - all targets attached → status "uploaded" (done; DataContext's
 *   reconcile removes the record as usual).
 * - round failed and rounds remain → stays "uploaded_pending_attach"
 *   with backoff, so the tick loop retries later — INCLUDING after an
 *   app relaunch, because status + attachAttemptCount are persisted.
 * - rounds exhausted → emits the terminal error event(s) (exactly once
 *   ever, since the transition to "uploaded" is persisted before/with
 *   the emit) and gives up: the photo stays on the project, subscribers
 *   alert the user to attach it manually.
 */
async function processAttach(item: QueuedUpload): Promise<void> {
  const mediaId = item.uploadedMediaId;
  if (typeof mediaId !== "number" || !Number.isFinite(mediaId)) {
    // Defensive: a pending_attach item without a mediaId can't proceed.
    updateItem(item.id, { status: "uploaded" });
    return;
  }
  const wantChecklist = !!item.checklistItemId && !item.checklistAttached;
  const wantTask = !!item.taskId && !item.taskAttached;
  if (!wantChecklist && !wantTask) {
    updateItem(item.id, { status: "uploaded", nextRetryAt: undefined });
    return;
  }

  const checklistOk = wantChecklist
    ? await attachChecklistRound(
        item.checklistItemId as string,
        mediaId,
        item.uploadedUrl,
      )
    : true;
  const taskOk = wantTask
    ? await attachTaskRound(item.taskId as string, mediaId, item.uploadedUrl)
    : true;

  const flags: Partial<QueuedUpload> = {};
  if (wantChecklist && checklistOk) flags.checklistAttached = true;
  if (wantTask && taskOk) flags.taskAttached = true;

  if (checklistOk && taskOk) {
    updateItem(item.id, {
      ...flags,
      status: "uploaded",
      lastError: undefined,
      lastErrorStatus: undefined,
      nextRetryAt: undefined,
    });
    return;
  }

  const rounds = (item.attachAttemptCount ?? 0) + 1;
  if (rounds >= MAX_ATTACH_ROUNDS) {
    // Terminal: persist the settled state DURABLY first — awaited, not
    // debounced — so a kill right after the alert can't resurrect the
    // retry (and re-alert every launch). The residual window is a kill
    // between the awaited write and the emit, which loses the alert but
    // never duplicates it (at-most-once by design).
    updateItem(item.id, {
      ...flags,
      status: "uploaded",
      attachAttemptCount: rounds,
      lastError: "Attach failed after retries",
      nextRetryAt: undefined,
    });
    await persistNow();
    const message = "Couldn't reach the server after repeated attempts";
    if (wantChecklist && !checklistOk) {
      emitAttach({
        checklistItemId: item.checklistItemId as string,
        mediaId,
        error: message,
      });
    }
    if (wantTask && !taskOk) {
      emitTaskAttach({ taskId: item.taskId as string, mediaId, error: message });
    }
    console.log(
      `[upload-queue] ✗ attach terminally failed for ${item.id} after ${rounds} rounds`,
    );
    return;
  }

  const delay = backoffDelay(rounds);
  updateItem(item.id, {
    ...flags,
    status: "uploaded_pending_attach",
    attachAttemptCount: rounds,
    lastError: "Attach pending retry",
    nextRetryAt: Date.now() + delay,
  });
  console.log(
    `[upload-queue] attach round ${rounds} failed for ${item.id} — retry in ${delay}ms`,
  );
}

function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(queue)).catch((e) =>
      console.log("[upload-queue] persist failed:", e),
    );
  }, PERSIST_DEBOUNCE_MS);
  notifySubscribers();
}

function updateItem(
  id: string,
  patch: Partial<QueuedUpload>,
): QueuedUpload | null {
  const idx = queue.findIndex((it) => it.id === id);
  if (idx === -1) return null;
  queue[idx] = { ...queue[idx], ...patch };
  schedulePersist();
  return queue[idx];
}

/**
 * Flush the (debounced) queue persist to AsyncStorage NOW and await the
 * write. Used for transitions that must be durable before observable
 * side effects — e.g. the terminal attach failure must hit disk before
 * its alert is emitted, otherwise a kill in the debounce window would
 * resurrect the retry and re-alert on the next launch.
 */
async function persistNow(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  notifySubscribers();
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  } catch (e) {
    console.log("[upload-queue] persistNow failed:", e);
  }
}

async function processItem(item: QueuedUpload): Promise<void> {
  const tag = `${item.id} (${item.originalName})`;
  console.log(
    `[upload-queue] starting ${tag} attempt=${item.attemptCount + 1}`,
  );
  try {
    // Pre-flight: confirm the local bytes still exist. A missing file is
    // permanent (the camera temp original is long gone) — flag it
    // unrecoverable instead of burning retries on an instant read failure.
    const exists = await localFileExists(item.localUri);
    if (exists === false) {
      const next = updateItem(item.id, {
        status: "unrecoverable",
        lastError: UNRECOVERABLE_MESSAGE,
        nextRetryAt: undefined,
      });
      if (next) reportUnrecoverable(next, "eviction");
      return;
    }

    // Step 1: sign
    const signedArr = await api.signUploads([
      {
        originalName: item.originalName,
        mimeType: item.mimeType,
        fileSize: item.fileSize,
      },
    ]);
    const signed = signedArr[0];
    if (!signed) throw new Error("signUploads returned an empty array");

    // Step 2: PUT to S3, with one auto-refresh retry on UploadExpiredError.
    let key = signed.key;
    let publicUrl = signed.publicUrl;
    let uploadUrl = signed.uploadUrl;
    try {
      await api.uploadToS3(uploadUrl, item.localUri, item.mimeType, item.fileSize);
    } catch (e) {
      if (e instanceof UploadExpiredError) {
        console.log(
          `[upload-queue] presigned URL expired for ${tag}; refreshing and retrying once`,
        );
        const resignedArr = await api.signUploads([
          {
            originalName: item.originalName,
            mimeType: item.mimeType,
            fileSize: item.fileSize,
          },
        ]);
        const resigned = resignedArr[0];
        if (!resigned)
          throw new Error("re-signUploads returned an empty array");
        key = resigned.key;
        publicUrl = resigned.publicUrl;
        uploadUrl = resigned.uploadUrl;
        await api.uploadToS3(
          uploadUrl,
          item.localUri,
          item.mimeType,
          item.fileSize,
        );
      } else {
        throw e;
      }
    }

    // Step 3: createMedia
    const createdArr = await api.createMedia(item.projectId, [
      {
        key,
        publicUrl,
        originalName: item.originalName,
        mimeType: item.mimeType,
        latitude: item.latitude,
        longitude: item.longitude,
        // Only include when present — the server accepts the field's
        // absence; null / "" must never be sent.
        ...(item.takenAt ? { takenAt: item.takenAt } : {}),
      },
    ]);
    const created = createdArr[0];
    if (!created) throw new Error("createMedia returned an empty array");

    // If the user removed the item while we were uploading, discard the
    // success silently — bytes already went to S3 but we won't persist
    // metadata locally.
    if (!queue.some((it) => it.id === item.id)) {
      console.log(
        `[upload-queue] ${tag} removed during upload; discarding success`,
      );
      return;
    }
    const mediaId =
      typeof created.id === "number" ? created.id : Number(created.id);
    const hasAttachTarget =
      Number.isFinite(mediaId) && !!(item.checklistItemId || item.taskId);
    // Items with an attach target park in "uploaded_pending_attach" —
    // PERSISTED — until the join-row POST succeeds, so an app kill
    // between media-create and attach can't strand the photo silently
    // off its checklist item / task. The tick loop resumes them exactly
    // like it resumes uploads.
    const updated = updateItem(item.id, {
      status: hasAttachTarget ? "uploaded_pending_attach" : "uploaded",
      uploadedMediaId: Number.isFinite(mediaId) ? mediaId : undefined,
      uploadedUrl: created.url,
      lastError: undefined,
      lastErrorStatus: undefined,
      nextRetryAt: undefined,
    });
    console.log(`[upload-queue] ✓ uploaded ${tag} → mediaId=${created.id}`);
    // The bytes are on S3 and the Media row exists — the pending copy is
    // no longer needed. Best-effort; the startup sweep catches leftovers.
    void deleteLocalFile(item.localUri);

    // Post-upload tagger: run the first attach round immediately (still
    // under this item's inFlight guard). Success/terminal results are
    // emitted via subscribeAttach / subscribeTaskAttach.
    if (hasAttachTarget && updated) {
      await processAttach(updated);
    }
    // TODO: notify DataContext to refresh project media after successful upload
  } catch (e) {
    if (!queue.some((it) => it.id === item.id)) {
      console.log(
        `[upload-queue] ${tag} removed during upload; discarding failure`,
      );
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    const lastErrorStatus = e instanceof ApiError ? e.status : undefined;
    const newAttemptCount = item.attemptCount + 1;
    const delay = backoffDelay(newAttemptCount);
    const nextRetryAt = Date.now() + delay;
    const failed = updateItem(item.id, {
      status: "failed",
      attemptCount: newAttemptCount,
      lastError: message,
      lastErrorStatus,
      nextRetryAt,
    });
    if (failed) {
      Sentry.addBreadcrumb({
        category: "upload-queue",
        level: "warning",
        message: "upload attempt failed",
        data: {
          classification: classifyUploadFailure(failed),
          status: lastErrorStatus ?? "n/a",
          attempt: newAttemptCount,
        },
      });
    }
    console.log(
      `[upload-queue] ✗ failed ${tag}: ${message} — retry in ${delay}ms (attempt ${newAttemptCount})`,
    );
  } finally {
    inFlight.delete(item.id);
  }
}

function tick(): void {
  if (!loaded) return;
  if (inFlight.size >= MAX_CONCURRENT) return;
  const now = Date.now();
  const eligible = queue
    .filter(
      (it) =>
        !inFlight.has(it.id) &&
        (it.status === "pending" ||
          (it.status === "failed" && (it.nextRetryAt ?? 0) <= now) ||
          (it.status === "uploaded_pending_attach" &&
            (it.nextRetryAt ?? 0) <= now)),
    )
    .sort((a, b) => a.createdAt - b.createdAt);

  for (const item of eligible) {
    if (inFlight.size >= MAX_CONCURRENT) break;
    inFlight.add(item.id);
    if (item.status === "uploaded_pending_attach") {
      // Bytes + Media row already exist — resume only the attach step
      // (this is the relaunch-recovery path; status must NOT be reset
      // to "uploading", the local file is already deleted).
      void processAttach(item).finally(() => inFlight.delete(item.id));
      continue;
    }
    updateItem(item.id, { status: "uploading" });
    void processItem({ ...item, status: "uploading" });
  }
}

function handleNetChange(isConnected: boolean): void {
  if (lastConnected === false && isConnected === true) {
    console.log(
      "[upload-queue] network reconnected; resetting failed-item retry timers",
    );
    const now = Date.now();
    let changed = false;
    queue = queue.map((it) => {
      if (it.status === "failed" || it.status === "uploaded_pending_attach") {
        changed = true;
        return { ...it, nextRetryAt: now };
      }
      return it;
    });
    if (changed) schedulePersist();
    tick();
  }
  lastConnected = isConnected;
}

// ---- Public API ----

export async function enqueueUpload(
  input: EnqueueInput,
): Promise<QueuedUpload> {
  await ensureLoaded();
  const item: QueuedUpload = {
    ...input,
    id: newId(),
    status: "pending",
    attemptCount: 0,
    createdAt: Date.now(),
  };
  queue = [...queue, item];
  console.log(
    `[upload-queue] enqueued ${item.id} (${item.originalName}) project=${item.projectId} size=${item.fileSize}`,
  );
  schedulePersist();
  tick();
  return item;
}

export async function getQueue(): Promise<QueuedUpload[]> {
  await ensureLoaded();
  return [...queue];
}

/**
 * Subscribe to attach-step results for uploads that carried a
 * `checklistItemId`. Fires exactly once per such upload with either a
 * `photo` (success) or an `error` (final failure after retries).
 * Returns an unsubscribe function.
 */
export function subscribeAttach(listener: AttachListener): () => void {
  attachSubscribers.add(listener);
  return () => {
    attachSubscribers.delete(listener);
  };
}

/**
 * Subscribe to attach-step results for uploads that carried a `taskId`.
 * Fires exactly once per such upload with either a `photo` (success) or
 * an `error` (final failure after retries). Returns an unsubscribe
 * function.
 */
export function subscribeTaskAttach(
  listener: TaskAttachListener,
): () => void {
  taskAttachSubscribers.add(listener);
  return () => {
    taskAttachSubscribers.delete(listener);
  };
}

export function subscribe(listener: Listener): () => void {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

export async function retryItem(id: string): Promise<void> {
  await ensureLoaded();
  const item = queue.find((it) => it.id === id);
  if (!item) return;
  // Unrecoverable items must never re-enter the retry loop — the local
  // file is gone and every attempt would fail instantly.
  if (
    item.status === "uploaded" ||
    item.status === "uploading" ||
    item.status === "unrecoverable"
  )
    return;
  updateItem(id, { nextRetryAt: Date.now() });
  console.log(
    `[upload-queue] manual retry requested for ${id} (${item.originalName})`,
  );
  tick();
}

export async function removeItem(id: string): Promise<void> {
  await ensureLoaded();
  const removed = queue.find((it) => it.id === id);
  const before = queue.length;
  queue = queue.filter((it) => it.id !== id);
  if (queue.length !== before) {
    console.log(`[upload-queue] removed ${id}`);
    schedulePersist();
  }
  // Free the pending bytes — nothing references them anymore.
  if (removed) void deleteLocalFile(removed.localUri);
}

/**
 * Wipe the entire queue (used when a user signs out via account deletion or
 * leaving the team — we don't want pending uploads to fire under the next
 * user's session).
 */
export async function clearAll(): Promise<void> {
  await ensureLoaded();
  if (queue.length === 0) return;
  console.log(`[upload-queue] clearAll: dropping ${queue.length} item(s)`);
  const dropped = queue;
  queue = [];
  schedulePersist();
  for (const it of dropped) void deleteLocalFile(it.localUri);
}

/**
 * Classify a non-successful queue item for the failed-upload UIs.
 *
 * - "unrecoverable": local file gone — Remove is the only valid action.
 * - "auth": last attempt died on a 401 from the API (sign/createMedia).
 *   The queue does NOT touch auth state — it just retries later.
 * - "network": everything else (status 0, 5xx, S3 errors) — retried
 *   automatically with backoff.
 */
export function classifyUploadFailure(
  item: QueuedUpload,
): "unrecoverable" | "auth" | "network" {
  if (item.status === "unrecoverable") return "unrecoverable";
  if (item.lastErrorStatus === 401) return "auth";
  return "network";
}

export function startProcessor(): void {
  if (tickInterval) return; // idempotent
  void ensureLoaded().then(() => {
    tick();
  });
  tickInterval = setInterval(tick, TICK_MS);

  // Subscribe to network changes; immediately retry failed items on reconnect.
  try {
    netUnsub = NetInfo.addEventListener((state) => {
      const isConnected =
        state.isConnected === true && state.isInternetReachable !== false;
      handleNetChange(isConnected);
    });
    NetInfo.fetch()
      .then((state) => {
        lastConnected =
          state.isConnected === true && state.isInternetReachable !== false;
      })
      .catch(() => {
        /* ignore */
      });
  } catch (e) {
    console.log("[upload-queue] NetInfo subscription failed:", e);
  }
  console.log("[upload-queue] processor started");
}
