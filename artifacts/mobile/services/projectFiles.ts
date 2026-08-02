import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";

import type { BackendProjectFile } from "@/services/api";

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
