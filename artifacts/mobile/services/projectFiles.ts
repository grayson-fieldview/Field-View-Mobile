import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";

import {
  api,
  type BackendProjectFile,
  type RegisterProjectFileItem,
  type SignFileUploadItem,
} from "@/services/api";

/**
 * Project file download + native share (read-only Files tab).
 *
 * Mirrors services/reportPdf.ts, with one difference: file URLs are
 * public unsigned CloudFront URLs (same as photo URLs), so we can hand
 * them straight to FileSystem.downloadAsync with NO auth headers —
 * no blob/base64 dance needed. The downloaded file is written under
 * cacheDirectory/fieldview/files/ and handed to expo-sharing's share
 * sheet (iOS Quick Look previews PDFs, Office docs and images natively).
 *
 * The cache file is intentionally kept on disk after sharing — the OS
 * reclaims the cache directory automatically, and re-opening the same
 * file is a no-op overwrite.
 */

// ----- Upload (3-step: sign → S3 PUT → register) -----
//
// Mirrors the web client's upload-files-dialog flow. The server
// allowlist validates extension AND mimeType TOGETHER, and the document
// picker reports empty/OS-dependent mime types for .heic and .csv — so
// the mimeType we sign and register is ALWAYS derived from the file
// extension via the map below (same approach as the web client), never
// taken from the picker.

/** Extension → mimeType map mirroring the server allowlist exactly. */
export const FILE_UPLOAD_MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  txt: "text/plain",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
};

/** Server cap: 50 MB per file. */
export const MAX_FILE_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Lower-cased extension without the dot, or null when there is none. */
export function fileExtension(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

export interface PickedUploadFile {
  /** Stable client-side id for status tracking — names can duplicate
   *  within a batch, so ids key all state and render keys; the name is
   *  display-only. */
  id: string;
  /** Local uri from the document picker. */
  uri: string;
  name: string;
  /** Size in bytes as reported by the picker; may be undefined. */
  size?: number;
}

/**
 * Client-side pre-flight (before any network round trip). Returns a
 * user-facing rejection reason, or null when the file is uploadable.
 */
export function validateUploadFile(file: PickedUploadFile): string | null {
  const ext = fileExtension(file.name);
  if (!ext || !FILE_UPLOAD_MIME_BY_EXT[ext]) {
    return `File type ${ext ? `.${ext}` : "(none)"} isn't supported.`;
  }
  if (typeof file.size !== "number" || !Number.isFinite(file.size)) {
    return "Couldn't read the file size.";
  }
  if (file.size > MAX_FILE_UPLOAD_BYTES) {
    return `Too large (${formatFileSize(file.size)}). Max is 50 MB.`;
  }
  if (file.size <= 0) {
    return "File is empty.";
  }
  return null;
}

export type UploadItemStatus = "pending" | "uploading" | "done" | "failed";

export interface UploadBatchResult {
  /** Files that were PUT to S3 and registered successfully. */
  succeeded: { id: string; name: string }[];
  /** Files that failed, with a user-facing reason each. */
  failed: { id: string; name: string; reason: string }[];
}

/**
 * Upload pre-validated files: one sign call for the batch, sequential
 * S3 PUTs (RN fetch has no upload-progress API, so callers show a
 * per-file spinner via onStatus — never a fake percentage), then ONE
 * register call for every file whose PUT succeeded. Partial failure
 * keeps the successes: a failed PUT only drops that file from the
 * register batch.
 *
 * CRITICAL wire rules (see the S3 sign contract in services/api.ts):
 * - contentDisposition from the sign response is sent VERBATIM as the
 *   PUT's Content-Disposition header (it is baked into the signature).
 * - key/publicUrl are registered exactly as returned by the sign call.
 * - The PUT is a raw fetch to the presigned URL: no auth headers, no
 *   cookie jar (api.uploadToS3 already behaves this way).
 */
export async function uploadProjectFiles(
  projectId: string | number,
  files: PickedUploadFile[],
  onStatus: (id: string, status: UploadItemStatus) => void,
): Promise<UploadBatchResult> {
  const failed: UploadBatchResult["failed"] = [];
  if (files.length === 0) return { succeeded: [], failed };

  const signItems: SignFileUploadItem[] = files.map((f) => ({
    originalName: f.name,
    // Derived from extension — validateUploadFile guarantees the ext
    // is in the map before we get here.
    mimeType: FILE_UPLOAD_MIME_BY_EXT[fileExtension(f.name) ?? ""] ?? "",
    fileSize: f.size ?? 0,
    folder: "files",
  }));

  // One sign call for the whole batch; response order matches input.
  const signed = await api.signFileUploads(signItems);
  if (!Array.isArray(signed) || signed.length !== files.length) {
    throw new Error("Sign response didn't match the requested files.");
  }

  const toRegister: RegisterProjectFileItem[] = [];
  const registered: { id: string; name: string }[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const sig = signed[i];
    onStatus(file.id, "uploading");
    try {
      await api.uploadToS3(
        sig.uploadUrl,
        file.uri,
        signItems[i].mimeType,
        signItems[i].fileSize,
        sig.contentDisposition,
      );
      toRegister.push({
        key: sig.key,
        publicUrl: sig.publicUrl,
        originalName: file.name,
        mimeType: signItems[i].mimeType,
        fileSize: signItems[i].fileSize,
      });
      registered.push({ id: file.id, name: file.name });
    } catch (e) {
      onStatus(file.id, "failed");
      failed.push({
        id: file.id,
        name: file.name,
        reason: e instanceof Error ? e.message : "Upload failed.",
      });
    }
  }

  if (toRegister.length === 0) return { succeeded: [], failed };

  try {
    await api.registerProjectFiles(projectId, toRegister);
  } catch (e) {
    // The whole register batch failed — every uploaded file is lost.
    for (const f of registered) onStatus(f.id, "failed");
    return {
      succeeded: [],
      failed: [
        ...failed,
        ...registered.map((f) => ({
          ...f,
          reason:
            e instanceof Error ? e.message : "Couldn't save the file record.",
        })),
      ],
    };
  }

  for (const f of registered) onStatus(f.id, "done");
  return { succeeded: registered, failed };
}

/** The name to render for a file — server never collapses these two. */
export function fileDisplayName(file: BackendProjectFile): string {
  return file.displayName ?? file.originalName;
}

/** "1.4 MB" style size label; null/invalid sizes render as null (omit). */
export function formatFileSize(sizeBytes: number | null): string | null {
  if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes) || sizeBytes < 0) {
    return null;
  }
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  const kb = sizeBytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)} GB`;
}

/**
 * Sanitize a user-supplied name into a safe cache filename. Keeps the
 * extension (case-lowered) so Quick Look / share targets can infer the
 * type from the path as well as the declared mimeType.
 */
function sanitizeFilename(name: string): string {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "") : "";
  const safeBase =
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "file";
  return ext ? `${safeBase}.${ext}` : safeBase;
}

/** iOS UTI for common mime types; undefined lets iOS infer from the file. */
function utiForMime(mimeType: string): string | undefined {
  const m = mimeType.toLowerCase();
  if (m === "application/pdf") return "com.adobe.pdf";
  if (m === "image/jpeg") return "public.jpeg";
  if (m === "image/png") return "public.png";
  if (m === "image/gif") return "com.compuserve.gif";
  if (m === "image/heic") return "public.heic";
  if (m.startsWith("image/")) return "public.image";
  if (m === "text/plain") return "public.plain-text";
  if (m === "text/csv") return "public.comma-separated-values-text";
  if (m === "application/msword") return "com.microsoft.word.doc";
  if (
    m ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  )
    return "org.openxmlformats.wordprocessingml.document";
  if (m === "application/vnd.ms-excel") return "com.microsoft.excel.xls";
  if (
    m === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  )
    return "org.openxmlformats.spreadsheetml.sheet";
  return undefined;
}

export async function downloadAndShareProjectFile(
  file: BackendProjectFile,
): Promise<void> {
  if (!FileSystem.cacheDirectory) {
    throw new Error("File system cache is unavailable on this device.");
  }
  const dir = `${FileSystem.cacheDirectory}fieldview/files/`;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(
    () => {
      // Already exists — non-fatal.
    },
  );
  // Prefix the id so two files with the same name never collide.
  const path = `${dir}${String(file.id)}-${sanitizeFilename(fileDisplayName(file))}`;
  const result = await FileSystem.downloadAsync(file.url, path);
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Download failed (HTTP ${result.status}).`);
  }
  const available = await Sharing.isAvailableAsync();
  if (!available) {
    throw new Error(
      "Sharing isn't available on this device. The file was saved to the app's cache.",
    );
  }
  await Sharing.shareAsync(result.uri, {
    mimeType: file.mimeType || undefined,
    UTI: utiForMime(file.mimeType ?? ""),
    dialogTitle: fileDisplayName(file),
  });
}
