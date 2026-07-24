import * as FileSystem from "expo-file-system/legacy";
import * as ImageManipulator from "expo-image-manipulator";

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  heif: "image/heic",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
};

export interface PreparedUpload {
  localUri: string;
  originalName: string;
  mimeType: string;
  fileSize: number;
}

/**
 * Copies a captured (or imported) file from its temporary location into the
 * app's private cache directory under `fieldview/photos/`. Returns metadata
 * suitable for the upload queue. Returns null on web (no cacheDirectory) or
 * if the copy fails — callers should fall back to using the source uri
 * without enqueueing.
 *
 * Shared by the capture screen (camera + its library import) and the
 * project gallery's add-from-camera-roll flow — one pipeline, no forks.
 */
export async function prepareForUpload(
  sourceUri: string,
  fallbackMime = "image/jpeg",
): Promise<PreparedUpload | null> {
  try {
    if (!FileSystem.cacheDirectory) {
      // Web or sandboxed env — no stable cache dir to copy into.
      return null;
    }
    const dir = `${FileSystem.cacheDirectory}fieldview/photos/`;
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(
      () => {
        /* already exists */
      },
    );

    // Derive extension from source uri (strip query string if any).
    const qIdx = sourceUri.indexOf("?");
    const cleanUri = qIdx >= 0 ? sourceUri.slice(0, qIdx) : sourceUri;
    const dotIdx = cleanUri.lastIndexOf(".");
    const rawExt = dotIdx > 0 ? cleanUri.slice(dotIdx + 1).toLowerCase() : "";
    const safeExt = /^[a-z0-9]{1,4}$/.test(rawExt) ? rawExt : "jpg";
    const mimeType = MIME_BY_EXT[safeExt] ?? fallbackMime;

    const originalName = `${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 10)}.${safeExt}`;
    const localUri = `${dir}${originalName}`;

    await FileSystem.copyAsync({ from: sourceUri, to: localUri });
    const info = await FileSystem.getInfoAsync(localUri);
    const fileSize = (info as { size?: number }).size ?? 0;

    console.log(
      `[imageProcessing] prepared ${originalName} (${mimeType}, ${fileSize} bytes) at ${localUri}`,
    );
    return { localUri, originalName, mimeType, fileSize };
  } catch (e) {
    console.log("[imageProcessing] prepareForUpload failed:", e);
    return null;
  }
}

/**
 * Photo capture aspect ratios supported by the account-level
 * `defaultPhotoAspectRatio` setting (web parity, S3y).
 *
 * Wire shape is `string` from `GET /api/account/settings`; consumers
 * should narrow to this union before persisting locally so an
 * unexpected server value (forward-compat scenario) gets rejected
 * loudly rather than silently passed to the cropper.
 */
export type PhotoAspectRatio = "4:3" | "1:1" | "16:9";

export const PHOTO_ASPECT_RATIOS: readonly PhotoAspectRatio[] = [
  "4:3",
  "1:1",
  "16:9",
] as const;

export const DEFAULT_PHOTO_ASPECT_RATIO: PhotoAspectRatio = "4:3";

/**
 * Numeric width/height ratio used by the center-crop math. Keep in
 * lock-step with PhotoAspectRatio.
 */
const RATIO_VALUES: Record<PhotoAspectRatio, number> = {
  "4:3": 4 / 3,
  "1:1": 1,
  "16:9": 16 / 9,
};

/**
 * Tolerance for skipping a no-op crop. A captured frame whose
 * native aspect is within ±1% of the target ratio is returned
 * untouched — saves a JPEG re-encode (~30-50ms on a mid-range
 * iPhone, more on Android) per shot. 1% is well below any visible
 * difference and well above floating-point noise.
 */
const RATIO_TOLERANCE = 0.01;

export function isPhotoAspectRatio(value: unknown): value is PhotoAspectRatio {
  return (
    typeof value === "string" &&
    (PHOTO_ASPECT_RATIOS as readonly string[]).includes(value)
  );
}

/**
 * Center-crop a captured photo to the requested aspect ratio.
 *
 * Orientation-aware (B11): the `ratio` setting is interpreted as a
 * LANDSCAPE shape (e.g. "16:9" = 16 wide × 9 tall) when the source
 * is landscape, and as the corresponding PORTRAIT shape (9 wide ×
 * 16 tall) when the source is portrait. This matches how field
 * users actually hold their phones: a contractor capturing a tall
 * doorway in portrait expects the saved photo to be tall too, not
 * letterboxed into landscape that loses the top and bottom of
 * what they framed. Square ("1:1") is orientation-symmetric and
 * unaffected.
 *
 * Always preserves the LONGER of the two dimensions that match the
 * target — i.e. for a 4032×3024 source cropped to 1:1 we keep the
 * full 3024px short edge and crop the long edge to 3024px (no
 * upscaling, no quality loss beyond the unavoidable JPEG re-encode).
 *
 * Re-encode quality: 0.9. Above the original 0.7 capture quality
 * (no point going higher) but high enough that the double
 * compression doesn't introduce visible artifacts. Tuned empirically
 * — bumping to 0.95 inflates file size 30-40% with no perceptible
 * gain on construction-site photo content.
 *
 * No-op fast path: returns the source object unchanged when the
 * native ratio is already within ±1% of the target. Caller can rely
 * on the returned uri being safe to enqueue regardless of crop path.
 *
 * Failure mode: surfaces the underlying `ImageManipulator` error.
 * Caller is expected to fall back to the uncropped source rather
 * than blocking the capture flow — better to ship an off-ratio
 * photo than no photo at all.
 */
export async function cropToAspectRatio(
  source: { uri: string; width: number; height: number },
  ratio: PhotoAspectRatio,
): Promise<{ uri: string; width: number; height: number }> {
  // Portrait sources flip the target ratio (B11). The DB enum stays
  // landscape-shaped ("4:3", "16:9") for cross-platform parity with
  // the web app, but on a portrait-held phone the user's intent is
  // the corresponding portrait shape (3:4, 9:16). 1:1 is symmetric.
  const baseTarget = RATIO_VALUES[ratio];
  const target = source.height > source.width ? 1 / baseTarget : baseTarget;
  const current = source.width / source.height;
  if (Math.abs(current - target) / target < RATIO_TOLERANCE) {
    return source;
  }

  // Decide which axis to crop. If source is wider than target we
  // crop horizontally (keep full height); else we crop vertically
  // (keep full width). Math.round avoids the rare sub-pixel error
  // that some Android encoders reject as "invalid crop region".
  let cropW: number;
  let cropH: number;
  if (current > target) {
    cropH = source.height;
    cropW = Math.round(cropH * target);
  } else {
    cropW = source.width;
    cropH = Math.round(cropW / target);
  }
  const originX = Math.round((source.width - cropW) / 2);
  const originY = Math.round((source.height - cropH) / 2);

  const result = await ImageManipulator.manipulateAsync(
    source.uri,
    [{ crop: { originX, originY, width: cropW, height: cropH } }],
    { compress: 0.9, format: ImageManipulator.SaveFormat.JPEG },
  );
  return { uri: result.uri, width: result.width, height: result.height };
}
