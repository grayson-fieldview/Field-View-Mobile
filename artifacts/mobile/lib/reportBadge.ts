import type { BackendReport } from "@/services/api";

/**
 * Shared report badge rule (matches web, 2026-08):
 *
 *   status "generating" -> Generating
 *   status "failed"     -> Failed   (outranks Shared)
 *   shareToken present  -> Shared
 *   otherwise           -> Ready
 *
 * Draft / Submitted / Approved / Exported no longer surface as labels.
 * Used by BOTH components/ReportListItem.tsx and app/report/[id].tsx —
 * do not re-inline label/color maps in either.
 */

export type ReportBadgeLabel = "Generating" | "Failed" | "Ready" | "Shared";

/** Semantic color slot — components resolve via useColors(). */
export type ReportBadgeTone = "muted" | "destructive" | "success";

export interface ReportBadge {
  label: ReportBadgeLabel;
  tone: ReportBadgeTone;
}

export function reportBadge(
  report: Pick<BackendReport, "status" | "shareToken">,
): ReportBadge {
  // Defensive read: AI-generated rows may carry an unexpected status.
  const status = typeof report.status === "string" ? report.status : "";
  if (status === "generating") return { label: "Generating", tone: "muted" };
  if (status === "failed") return { label: "Failed", tone: "destructive" };
  if (typeof report.shareToken === "string" && report.shareToken.length > 0) {
    return { label: "Shared", tone: "success" };
  }
  return { label: "Ready", tone: "muted" };
}
