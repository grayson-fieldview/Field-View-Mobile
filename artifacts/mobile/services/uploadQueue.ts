import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import {
  api,
  UploadExpiredError,
  type BackendChecklistItemPhoto,
} from "./api";
import { newId } from "./id";

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
  status: "pending" | "uploading" | "uploaded" | "failed";
  attemptCount: number;
  nextRetryAt?: number;
  lastError?: string;
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
      nextRetryAt: undefined,
    });
    console.log(`[upload-queue] ✓ uploaded ${tag} → mediaId=${created.id}`);

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
    const newAttemptCount = item.attemptCount + 1;
    const delay = backoffDelay(newAttemptCount);
    const nextRetryAt = Date.now() + delay;
    updateItem(item.id, {
      status: "failed",
      attemptCount: newAttemptCount,
      lastError: message,
      nextRetryAt,
    });
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
  if (item.status === "uploaded" || item.status === "uploading") return;
  updateItem(id, { nextRetryAt: Date.now() });
  console.log(
    `[upload-queue] manual retry requested for ${id} (${item.originalName})`,
  );
  tick();
}

export async function removeItem(id: string): Promise<void> {
  await ensureLoaded();
  const before = queue.length;
  queue = queue.filter((it) => it.id !== id);
  if (queue.length !== before) {
    console.log(`[upload-queue] removed ${id}`);
    schedulePersist();
  }
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
  queue = [];
  schedulePersist();
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
