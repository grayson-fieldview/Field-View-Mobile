import * as FileSystem from "expo-file-system/legacy";
import * as ImageManipulator from "expo-image-manipulator";

/**
 * On-device downsampled thumbnail cache (memory-fix part B, option B1).
 *
 * WHY B1 and not expo-image decode hints (B2): expo-image's
 * `allowDownscaling` cannot be verified to prevent the full-resolution
 * decode — SDWebImage/Glide decode the full bitmap before downscaling
 * on several paths, and remote tiles pull ORIGINAL S3 URLs where no
 * cross-platform decode-size control exists. B1 guarantees the grid
 * only ever hands expo-image a ~400px JPEG, bounding decode memory to
 * ~0.65 MB per tile regardless of source resolution.
 *
 * Contract:
 *   - getThumbnailUri(key, sourceUri) → cached file uri, generating on
 *     first request. LAZY: callers request only for mounted tiles (the
 *     grid is virtualized, so mounted ≈ visible).
 *   - Concurrency-bounded: at most MAX_CONCURRENT generations in
 *     flight; the rest queue FIFO.
 *   - Failure → resolves to the ORIGINAL sourceUri (caller renders it
 *     as before — correctness over memory), remembered per-run so a
 *     bad source doesn't retry in a loop, but retried on next launch.
 *   - Cache: FileSystem.cacheDirectory/fv-thumbs-v1/<key>.jpg. The OS
 *     may purge cacheDirectory; we additionally cap file count and
 *     evict oldest-modified first.
 *   - Keys are caller-chosen and stable (media id for grid tiles), so
 *     a pending local photo that later syncs keeps its thumbnail — no
 *     re-download of the original just to re-thumb the same pixels.
 */

const DIR = `${FileSystem.cacheDirectory ?? ""}fv-thumbs-v1/`;
export const THUMB_WIDTH = 400;
const MAX_CONCURRENT = 3;
/** ~30-60 KB per thumb → cap keeps the cache well under ~60 MB disk. */
const MAX_CACHE_FILES = 1000;

/**
 * Per-run resolution memo, keyed by (cacheKey, sourceUri) — NOT cacheKey
 * alone. The disk file is keyed by cacheKey (same media id → same thumb
 * even when a pending local uri later swaps to the remote URL), but the
 * memo must include the uri: if generation FAILED for one uri (e.g. the
 * pending file was deleted mid-reconcile) the fallback memo must not
 * block a retry when the same photo's uri changes to a live remote URL.
 */
const resolved = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();
const memoKey = (key: string, uri: string): string => `${key}\u0000${uri}`;

/** Synchronous lookup so already-thumbed tiles render without a flash. */
export function getCachedThumbnailUriSync(
  key: string,
  sourceUri: string,
): string | null {
  return resolved.get(memoKey(key, sourceUri)) ?? null;
}

const safeKey = (key: string): string => key.replace(/[^a-zA-Z0-9._-]/g, "_");

/**
 * Stable cache key for surfaces that only have a URI (project-list
 * covers), not a media id. djb2 over the uri: same source → same thumb;
 * a changed cover url naturally produces a fresh key.
 */
export function thumbKeyForUri(uri: string): string {
  let h = 5381;
  for (let i = 0; i < uri.length; i++) {
    h = ((h << 5) + h + uri.charCodeAt(i)) | 0;
  }
  return `u${(h >>> 0).toString(36)}`;
}

// ---- tiny FIFO concurrency gate ----
let active = 0;
const waiters: (() => void)[] = [];
async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return;
  }
  await new Promise<void>((res) => waiters.push(res));
  active++;
}
function release(): void {
  active--;
  const next = waiters.shift();
  if (next) next();
}

let dirReady: Promise<void> | null = null;
function ensureDir(): Promise<void> {
  if (!dirReady) {
    dirReady = (async () => {
      const info = await FileSystem.getInfoAsync(DIR);
      if (!info.exists) {
        await FileSystem.makeDirectoryAsync(DIR, { intermediates: true });
      }
      // Fire-and-forget eviction sweep, once per run. Never blocks
      // thumbnail generation; failures are non-fatal (cache dir is
      // OS-purgeable anyway).
      void evictIfOverCap().catch(() => {});
    })();
  }
  return dirReady;
}

async function evictIfOverCap(): Promise<void> {
  const names = await FileSystem.readDirectoryAsync(DIR);
  if (names.length <= MAX_CACHE_FILES) return;
  const stats = await Promise.all(
    names.map(async (n) => {
      const info = await FileSystem.getInfoAsync(DIR + n);
      return {
        name: n,
        mtime: info.exists ? (info.modificationTime ?? 0) : 0,
      };
    }),
  );
  stats.sort((a, b) => a.mtime - b.mtime); // oldest first
  const excess = stats.slice(0, names.length - MAX_CACHE_FILES);
  for (const f of excess) {
    await FileSystem.deleteAsync(DIR + f.name, { idempotent: true });
  }
}

async function generate(key: string, sourceUri: string): Promise<string> {
  await ensureDir();
  const dest = `${DIR}${safeKey(key)}.jpg`;
  const existing = await FileSystem.getInfoAsync(dest);
  if (existing.exists) return dest;

  // Remote sources: ImageManipulator needs a local file on Android, so
  // download to a temp path first (disk, not memory), thumb it, delete.
  let input = sourceUri;
  let tmp: string | null = null;
  if (/^https?:\/\//i.test(sourceUri)) {
    tmp = `${DIR}${safeKey(key)}.src`;
    const dl = await FileSystem.downloadAsync(sourceUri, tmp);
    if (dl.status !== 200) {
      throw new Error(`thumbnail source download failed (${dl.status})`);
    }
    input = tmp;
  }
  try {
    const result = await ImageManipulator.manipulateAsync(
      input,
      [{ resize: { width: THUMB_WIDTH } }],
      { compress: 0.6, format: ImageManipulator.SaveFormat.JPEG },
    );
    await FileSystem.moveAsync({ from: result.uri, to: dest });
    return dest;
  } finally {
    if (tmp) void FileSystem.deleteAsync(tmp, { idempotent: true });
  }
}

/**
 * Resolve a bounded-size thumbnail uri for (key, sourceUri). Never
 * rejects: falls back to the original sourceUri on any failure.
 */
export function getThumbnailUri(
  key: string,
  sourceUri: string,
): Promise<string> {
  const mk = memoKey(key, sourceUri);
  const memo = resolved.get(mk);
  if (memo) return Promise.resolve(memo);
  const running = inflight.get(mk);
  if (running) return running;

  const job = (async () => {
    await acquire();
    try {
      const uri = await generate(key, sourceUri);
      resolved.set(mk, uri);
      return uri;
    } catch (e) {
      console.warn(
        `[thumbnails] generation failed for ${key}; falling back to original`,
        e instanceof Error ? e.message : e,
      );
      // Per-run memo of the fallback for THIS (key, uri) pair only:
      // don't retry-loop a bad source this session, but a changed uri
      // for the same key (pending file → remote URL) retries fresh.
      resolved.set(mk, sourceUri);
      return sourceUri;
    } finally {
      release();
      inflight.delete(mk);
    }
  })();
  inflight.set(mk, job);
  return job;
}

/** Test hook: reset per-run memos. */
export function _resetThumbnailMemos(): void {
  resolved.clear();
  inflight.clear();
}
