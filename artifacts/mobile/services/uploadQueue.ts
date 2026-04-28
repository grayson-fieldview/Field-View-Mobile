import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import { api, UploadExpiredError } from "./api";
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
  status: "pending" | "uploading" | "uploaded" | "failed";
  attemptCount: number;
  nextRetryAt?: number;
  lastError?: string;
  createdAt: number;
  uploadedMediaId?: number;
}

export type EnqueueInput = Omit<
  QueuedUpload,
  "id" | "status" | "attemptCount" | "createdAt"
>;

type Listener = (queue: QueuedUpload[]) => void;

// ---- Module state ----
let queue: QueuedUpload[] = [];
let loaded = false;
let loadPromise: Promise<void> | null = null;
const subscribers = new Set<Listener>();
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
      lastError: undefined,
      nextRetryAt: undefined,
    });
    console.log(`[upload-queue] ✓ uploaded ${tag} → mediaId=${created.id}`);
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
