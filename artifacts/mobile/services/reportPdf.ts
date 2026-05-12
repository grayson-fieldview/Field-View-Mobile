import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";

import { api } from "@/services/api";

/**
 * Mobile Reports R1 — PDF download + native share.
 *
 * The server endpoint POST /api/reports/:id/pdf returns a binary
 * `application/pdf` stream (NOT JSON). This module wraps:
 *
 *   1. fetch the blob via api.generateReportPdf (which handles auth
 *      cookies internally on native and `credentials: "include"` on web),
 *   2. write it to FileSystem.cacheDirectory under fieldview/reports/,
 *   3. hand the file path to expo-sharing's native share sheet.
 *
 * Filename convention mirrors the server's Content-Disposition:
 *   `${slug}-${YYYY-MM-DD}.pdf`
 *
 * The cache file is intentionally kept on disk after sharing — the OS
 * cache directory is reclaimed automatically and re-sharing the same
 * report on the same day is a no-op overwrite.
 */

function todayISO(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "report"
  );
}

/**
 * Read a Blob as base64 via FileReader. We avoid `btoa(String.fromCharCode(...))`
 * because that path is fragile on Hermes for large binary payloads
 * (call-stack overflow and surrogate-pair quirks). FileReader is
 * implemented natively in React Native and handles binary blobs
 * deterministically.
 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read PDF"));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Unexpected FileReader result type"));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

export async function downloadAndSharePdf(
  reportId: string | number,
  title: string,
): Promise<void> {
  if (!FileSystem.cacheDirectory) {
    throw new Error("File system cache is unavailable on this device.");
  }
  const blob = await api.generateReportPdf(reportId);
  if (!blob || (typeof blob.size === "number" && blob.size === 0)) {
    throw new Error("Server returned an empty PDF.");
  }
  const base64 = await blobToBase64(blob);
  if (!base64) {
    throw new Error("PDF payload was empty after decoding.");
  }
  const filename = `${slugify(title)}-${todayISO()}.pdf`;
  const dir = `${FileSystem.cacheDirectory}fieldview/reports/`;
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(
    () => {
      // Already exists — non-fatal.
    },
  );
  const path = `${dir}${filename}`;
  await FileSystem.writeAsStringAsync(path, base64, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const available = await Sharing.isAvailableAsync();
  if (!available) {
    throw new Error(
      "Sharing isn't available on this device. The PDF was saved to the app's cache.",
    );
  }
  await Sharing.shareAsync(path, {
    mimeType: "application/pdf",
    UTI: "com.adobe.pdf",
    dialogTitle: "Share report PDF",
  });
}
