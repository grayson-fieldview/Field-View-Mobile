import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import * as FileSystem from "expo-file-system/legacy";

import {
  ApiError,
  api,
  UploadExpiredError,
  type BackendChecklistItemPhoto,
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
   * Optional checklist-item attach target. When set, the post-upload tagger
   * (see processItem) calls api.attachPhotoToItem(checklistItemId, mediaId)
   * after the Media row is created. Errors there are logged but do not fail
   * the upload — the photo still lands on the project.
   */
  checklistItemId?: string;
  /**
   * "unrecoverable" = the local file no longer exists on device (iOS
   * evicted it, or a legacy cache-dir item's bytes were purged before
   * the documentDirectory migration). Excluded from all retry/backoff
   * processing — the only valid user action is Remove.
   */
  status: "pending" | "uploading" | "uploaded" | "failed" | "unrecoverable";
  attemptCount: number;
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

// ---- Module state ----
let queue: QueuedUpload[] = [];
let loaded = false;
let loadPromise: Promise<void> | null = null;
const subscribers = new Set<Listener>();
const attachSubscribers = new Set<AttachListener>();
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
      // Terminal states keep their record as-is.
      if (it.status === "uploaded" || it.status === "unrecoverable") {
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

const ATTACH_RETRY_DELAYS_MS = [0, 2_000, 8_000];

async function attachWithRetry(
  checklistItemId: string,
  mediaId: number,
  uploadedUrl?: string,
): Promise<void> {
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
      return;
    } catch (e) {
      lastErr = e;
      console.log(
        `[upload-queue] attach attempt ${i + 1} failed for media ${mediaId} → item ${checklistItemId}:`,
        e,
      );
    }
  }
  const message =
    lastErr instanceof Error ? lastErr.message : String(lastErr ?? "unknown error");
  emitAttach({ checklistItemId, mediaId, error: message });
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
    updateItem(item.id, {
      status: "uploaded",
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

    // Post-upload tagger: if this upload was scoped to a checklist item,
    // attach the new media to that item. Async-with-retry — the upload
    // itself stays "uploaded" regardless (the photo is already on the
    // project). The result of the attach (success or final failure) is
    // emitted via subscribeAttach so the checklist UI can react without
    // polling/timing hacks.
    if (item.checklistItemId && Number.isFinite(mediaId)) {
      void attachWithRetry(item.checklistItemId, mediaId, created.url);
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
          (it.status === "failed" && (it.nextRetryAt ?? 0) <= now)),
    )
    .sort((a, b) => a.createdAt - b.createdAt);

  for (const item of eligible) {
    if (inFlight.size >= MAX_CONCURRENT) break;
    inFlight.add(item.id);
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
      if (it.status === "failed") {
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
